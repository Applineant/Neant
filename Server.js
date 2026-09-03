const express = require('express');
const cors = require('cors');
// Remplace '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' par ta vraie clé secrète Stripe
const stripe = require('stripe')('sk_test_VOTRE_CLE_SECRETE_ICI');

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint pour générer le paiement Stripe
app.post('/create-payment-intent', async (req, res) => {
    try {
        const { amount } = req.body;
        // Conversion de l'euro en centimes pour Stripe
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: 'eur',
            payment_method_types: ['card'],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Serveur NÉANT V1 démarré sur http://localhost:${PORT}`);
});