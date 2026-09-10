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

// --- Persistance simple dans un fichier JSON ---
// Sur le plan gratuit Render, ce fichier est perdu à chaque redéploiement
// (disque non persistant) : pour une vraie prod, remplacer par une DB
// (ex: Render PostgreSQL gratuit).
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function findOrCreateUser(users, userKey) {
    let user = users.find(u => u.key === userKey);
    if (!user) {
        user = { key: userKey, name: 'Mécène_Anonyme', amount: 0, purchaseBadges: [], voidMaxSeconds: 0, voidBadges: [], chaseBadges: [] };
        users.push(user);
    }
    if (!user.purchaseBadges) user.purchaseBadges = [];
    if (!user.voidBadges) user.voidBadges = [];
    if (!user.voidMaxSeconds) user.voidMaxSeconds = 0;
    if (!user.chaseBadges) user.chaseBadges = [];
    return user;
}

// Génère un pseudo garanti unique (ajoute #1234 si déjà pris par quelqu'un d'autre)
function makeUniquePseudo(users, desiredName, userKey) {
    const takenByOther = (name) => users.some(u => u.name === name && u.key !== userKey);

    if (!takenByOther(desiredName)) return desiredName;

    let suffix = Math.floor(1000 + Math.random() * 9000);
    let candidate = `${desiredName}#${suffix}`;
    while (takenByOther(candidate)) {
        suffix = Math.floor(1000 + Math.random() * 9000);
        candidate = `${desiredName}#${suffix}`;
    }
    return candidate;
}

// --- Badges d'achat (montant total cumulé) ---
const PURCHASE_BADGES = [
    { id: 'first',    threshold: 0,    name: 'Néophyte du Vide' },       // débloqué au tout premier achat
    { id: '5',        threshold: 5,    name: 'Chevalier du Rien' },
    { id: '10',       threshold: 10,   name: 'Baron de la Futilité' },
    { id: '20',       threshold: 20,   name: 'Duc du Néant' },
    { id: '50',       threshold: 50,   name: 'Prince de l\'Absence' },
    { id: '100',      threshold: 100,  name: 'Empereur du Vide' },
    { id: '500',      threshold: 500,  name: 'Divinité du Rien' },
    { id: '1000',     threshold: 1000, name: 'Légende Absolue du Néant' }
];

// --- Badges du Vide (temps max passé sur l'écran noir, en secondes) ---
const VOID_BADGES = [
    { id: '10s',   threshold: 10,   name: 'Curieux du Vide' },
    { id: '30s',   threshold: 30,   name: 'Observateur du Néant' },
    { id: '1min',  threshold: 60,   name: 'Contemplateur du Rien' },
    { id: '5min',  threshold: 300,  name: 'Moine du Vide' },
    { id: '15min', threshold: 900,  name: 'Ermite du Néant' },
    { id: '30min', threshold: 1800, name: 'Illuminé du Rien' },
    { id: '1h',    threshold: 3600, name: 'Transcendé Absolu' }
];

function computeNewPurchaseBadges(user, isFirstPurchaseEver) {
    const unlocked = [];
    for (const badge of PURCHASE_BADGES) {
        const alreadyHas = user.purchaseBadges.includes(badge.id);
        const qualifies = badge.id === 'first' ? isFirstPurchaseEver : user.amount >= badge.threshold;
        if (qualifies && !alreadyHas) {
            user.purchaseBadges.push(badge.id);
            unlocked.push(badge);
        }
    }
    return unlocked;
}

function computeNewVoidBadges(user) {
    const unlocked = [];
    for (const badge of VOID_BADGES) {
        const alreadyHas = user.voidBadges.includes(badge.id);
        if (user.voidMaxSeconds >= badge.threshold && !alreadyHas) {
            user.voidBadges.push(badge.id);
            unlocked.push(badge);
        }
    }
    return unlocked;
}

// --- Badge de la Chasse au Rien (attrapé une seule fois, débloqué au premier succès) ---
const CHASE_BADGE = { id: 'chase', name: 'Chasseur du Vide' };

function computeNewChaseBadge(user) {
    if (!user.chaseBadges.includes(CHASE_BADGE.id)) {
        user.chaseBadges.push(CHASE_BADGE.id);
        return [CHASE_BADGE];
    }
    return [];
}

function highestBadgeName(user) {
    const ids = user.purchaseBadges || [];
    for (let i = PURCHASE_BADGES.length - 1; i >= 0; i--) {
        if (ids.includes(PURCHASE_BADGES[i].id)) return PURCHASE_BADGES[i].name;
    }
    return null;
}

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
        console.error('Erreur Stripe complète :', error);
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

// Récupère le classement (top 20, trié par montant décroissant), avec le
// badge d'achat le plus élevé de chacun pour affichage.
app.get('/leaderboard', (req, res) => {
    const users = loadUsers();
    const sorted = [...users].sort((a, b) => b.amount - a.amount).slice(0, 20);
    const result = sorted.map(u => ({
        key: u.key,
        name: u.name,
        amount: u.amount,
        topBadge: highestBadgeName(u)
    }));
    res.send(result);
});

// Ajoute/met à jour un score au classement + calcule les badges d'achat
// nouvellement débloqués. Le montant ajouté vient toujours de Stripe,
// jamais du client.
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

        let users = loadUsers();
        const isFirstPurchaseEver = !users.some(u => u.key === userKey);
        const user = findOrCreateUser(users, userKey);

        user.name = makeUniquePseudo(users, desiredName, userKey);
        user.amount += amountToAdd;

        const newBadges = computeNewPurchaseBadges(user, isFirstPurchaseEver);

        saveUsers(users);

        const sorted = [...users].sort((a, b) => b.amount - a.amount).slice(0, 20)
            .map(u => ({ key: u.key, name: u.name, amount: u.amount, topBadge: highestBadgeName(u) }));

        res.send({ finalName: user.name, leaderboard: sorted, newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Enregistre le temps passé sur "l'écran du Vide" et calcule les badges
// de contemplation nouvellement débloqués.
app.post('/void-time', (req, res) => {
    try {
        const { userKey, seconds } = req.body;

        if (!userKey || typeof seconds !== 'number' || seconds < 0) {
            return res.status(400).send({ error: 'Champs invalides.' });
        }

        // On plafonne à 6h pour éviter les valeurs absurdes envoyées manuellement.
        const cappedSeconds = Math.min(seconds, 21600);

        let users = loadUsers();
        const user = findOrCreateUser(users, userKey);

        if (cappedSeconds > user.voidMaxSeconds) {
            user.voidMaxSeconds = cappedSeconds;
        }

        const newBadges = computeNewVoidBadges(user);
        saveUsers(users);

        res.send({ voidMaxSeconds: user.voidMaxSeconds, newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Renvoie le catalogue complet des badges avec l'état débloqué/verrouillé
// pour cet utilisateur, ainsi que sa progression actuelle sur chaque axe.
app.get('/my-badges', (req, res) => {
    try {
        const userKey = req.query.userKey;
        if (!userKey) {
            return res.status(400).send({ error: 'userKey manquant.' });
        }

        const users = loadUsers();
        const user = users.find(u => u.key === userKey) || {
            amount: 0, purchaseBadges: [], voidMaxSeconds: 0, voidBadges: [], chaseBadges: []
        };

        const purchase = PURCHASE_BADGES.map(b => ({
            id: b.id,
            name: b.name,
            threshold: b.threshold,
            unlocked: user.purchaseBadges.includes(b.id)
        }));

        const voidCat = VOID_BADGES.map(b => ({
            id: b.id,
            name: b.name,
            threshold: b.threshold,
            unlocked: user.voidBadges.includes(b.id)
        }));

        const chase = [{
            id: CHASE_BADGE.id,
            name: CHASE_BADGE.name,
            unlocked: user.chaseBadges.includes(CHASE_BADGE.id)
        }];

        res.send({
            amount: user.amount,
            voidMaxSeconds: user.voidMaxSeconds,
            purchase,
            void: voidCat,
            chase
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Enregistre la capture du bouton "Rien" et débloque le badge associé.
app.post('/chase-catch', (req, res) => {
    try {
        const { userKey, attempts } = req.body;

        if (!userKey) {
            return res.status(400).send({ error: 'userKey manquant.' });
        }

        let users = loadUsers();
        const user = findOrCreateUser(users, userKey);

        const newBadges = computeNewChaseBadge(user);
        saveUsers(users);

        res.send({ newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Render attribue un port dynamiquement via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
