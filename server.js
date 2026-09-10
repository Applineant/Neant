const express = require('express');
const cors = require('cors');
const path = require('path');
const PDFDocument = require('pdfkit');

// Récupération de la clé Stripe depuis les variables d'environnement Render
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

// Render attribue un port dynamiquement via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
