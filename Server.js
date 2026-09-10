const express = require('express');
const cors = require('cors');
const path = require('path');

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

// Render attribue un port dynamiquement via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
