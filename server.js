const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// Récupération de la clé Stripe depuis les variables d'environnement Render
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 0,
    timeout: 20000
});

const app = express();
app.use(cors());
app.use(express.json());

// Servir les fichiers statiques (index.html, CSS, JS, audio)
app.use(express.static(__dirname));

// --- Persistance simple du classement dans un fichier JSON ---
// Sur le plan gratuit Render, ce fichier est perdu à chaque redéploiement
// (disque non persistant) : pour une vraie prod, remplacer par une DB
// (ex: Render PostgreSQL gratuit).
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

function loadLeaderboard() {
    try {
        return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveLeaderboard(data) {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2));
}

// Génère un pseudo garanti unique dans le classement (ajoute #1234 si pris)
function makeUniquePseudo(leaderboard, desiredName, userKey) {
    const takenByOther = (name) => leaderboard.some(u => u.name === name && u.key !== userKey);

    if (!takenByOther(desiredName)) return desiredName;

    let suffix = Math.floor(1000 + Math.random() * 9000);
    let candidate = `${desiredName}#${suffix}`;
    while (takenByOther(candidate)) {
        suffix = Math.floor(1000 + Math.random() * 9000);
        candidate = `${desiredName}#${suffix}`;
    }
    return candidate;
}

// Route principale pour charger index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Whitelist des tarifs autorisés (en euros). Le client n'envoie plus jamais
// le montant : il envoie un identifiant "tier", et c'est le serveur seul
// qui décide du prix réel facturé.
const TIERS = {
    base:     1.00,
    birthday: 2.50,
    dopamine: 5.00,
    upsell:   1.00
};

// Endpoint pour générer le paiement Stripe
app.post('/create-payment-intent', async (req, res) => {
    try {
        const { tier } = req.body;
        const amount = TIERS[tier];

        if (!amount) {
            return res.status(400).send({ error: 'Tier invalide.' });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: 'eur',
            automatic_payment_methods: {
                enabled: true,
            },
        });
        res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Endpoint : génère le certificat PDF d'achat de Néant.
// On revérifie le PaymentIntent auprès de Stripe pour être sûr que le
// paiement a bien été confirmé avant de délivrer le certificat, et on
// prend le montant/la devise depuis Stripe (jamais depuis le client).
app.post('/certificate', async (req, res) => {
    try {
        const { paymentIntentId, pseudo } = req.body;

        if (!paymentIntentId) {
            return res.status(400).send({ error: 'paymentIntentId manquant.' });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).send({ error: 'Paiement non confirmé.' });
        }

        const amount = (paymentIntent.amount / 100).toFixed(2);
        const safePseudo = (pseudo || 'Mécène Anonyme').toString().slice(0, 40);
        const certifNumber = 'NEANT-' + paymentIntent.id.slice(-8).toUpperCase();
        const date = new Date(paymentIntent.created * 1000).toLocaleDateString('fr-FR', {
            year: 'numeric', month: 'long', day: 'numeric'
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="certificat-neant-${certifNumber}.pdf"`);

        const doc = new PDFDocument({ size: 'A4', margin: 60 });
        doc.pipe(res);

        // Cadre décoratif
        doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60)
           .lineWidth(2)
           .stroke('#111111');

        doc.moveDown(4);
        doc.font('Helvetica-Bold').fontSize(34).fillColor('#111111')
           .text('CERTIFICAT DE NÉANT', { align: 'center' });

        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(12).fillColor('#555555')
           .text('Attestation officielle d\'achat d\'absolument rien', { align: 'center' });

        doc.moveDown(3);
        doc.font('Helvetica').fontSize(13).fillColor('#111111')
           .text('Ceci certifie que', { align: 'center' });

        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(24)
           .text(safePseudo, { align: 'center' });

        doc.moveDown(1);
        doc.font('Helvetica').fontSize(13)
           .text(`a dépensé la somme de ${amount} € pour ne recevoir absolument rien,`, { align: 'center' })
           .text('acte de futilité pure et assumée.', { align: 'center' });

        doc.moveDown(3);
        doc.fontSize(10).fillColor('#777777')
           .text(`Numéro de certificat : ${certifNumber}`, { align: 'center' })
           .text(`Délivré le ${date}`, { align: 'center' });

        doc.moveDown(2);
        doc.fontSize(9).fillColor('#999999')
           .text('NÉANT. — Le seul concept où c\'est vous qui décidez combien vous voulez perdre.', { align: 'center' });

        doc.end();
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Récupère le classement (top 20, trié par montant décroissant)
app.get('/leaderboard', (req, res) => {
    const leaderboard = loadLeaderboard();
    leaderboard.sort((a, b) => b.amount - a.amount);
    res.send(leaderboard.slice(0, 20));
});

// Ajoute/met à jour un score au classement.
// On revérifie le paiement auprès de Stripe (montant + statut) avant
// d'ajouter quoi que ce soit : le montant ajouté ne vient jamais du client.
app.post('/leaderboard', async (req, res) => {
    try {
        const { paymentIntentId, userKey, pseudo } = req.body;

        if (!paymentIntentId || !userKey) {
            return res.status(400).send({ error: 'Champs manquants.' });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).send({ error: 'Paiement non confirmé.' });
        }

        const amountToAdd = paymentIntent.amount / 100;
        const desiredName = (pseudo || 'Mécène_Anonyme').toString().trim().slice(0, 30) || 'Mécène_Anonyme';

        let leaderboard = loadLeaderboard();
        const finalName = makeUniquePseudo(leaderboard, desiredName, userKey);

        const existing = leaderboard.find(u => u.key === userKey);
        if (existing) {
            existing.amount += amountToAdd;
            existing.name = finalName;
        } else {
            leaderboard.push({ key: userKey, name: finalName, amount: amountToAdd });
        }

        saveLeaderboard(leaderboard);
        leaderboard.sort((a, b) => b.amount - a.amount);
        res.send({ finalName, leaderboard: leaderboard.slice(0, 20) });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Render attribue un port dynamiquement via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
