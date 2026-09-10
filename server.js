const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');

// Récupération de la clé Stripe depuis les variables d'environnement Render
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 0,
    timeout: 20000
});

// Connexion PostgreSQL (Neon) — l'URL complète vit UNIQUEMENT dans la
// variable d'environnement DATABASE_URL sur Render, jamais dans le code.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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

// --- Initialisation de la table (persistante, contrairement au disque
// Render éphémère utilisé auparavant pour le fichier JSON) ---
async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            key TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT 'Mécène_Anonyme',
            amount NUMERIC NOT NULL DEFAULT 0,
            purchase_badges JSONB NOT NULL DEFAULT '[]',
            void_max_seconds INTEGER NOT NULL DEFAULT 0,
            void_badges JSONB NOT NULL DEFAULT '[]',
            chase_badges JSONB NOT NULL DEFAULT '[]',
            click_best INTEGER NOT NULL DEFAULT 0,
            click_badges JSONB NOT NULL DEFAULT '[]'
        )
    `);
}
initDb().catch(err => console.error('Erreur init DB :', err));

async function getOrCreateUser(userKey) {
    const existing = await pool.query('SELECT * FROM users WHERE key = $1', [userKey]);
    if (existing.rows.length > 0) return existing.rows[0];

    const inserted = await pool.query(
        `INSERT INTO users (key) VALUES ($1) RETURNING *`,
        [userKey]
    );
    return inserted.rows[0];
}

// Génère un pseudo garanti unique (ajoute #1234 si déjà pris par quelqu'un d'autre)
async function makeUniquePseudo(desiredName, userKey) {
    const taken = await pool.query(
        'SELECT 1 FROM users WHERE name = $1 AND key != $2',
        [desiredName, userKey]
    );
    if (taken.rows.length === 0) return desiredName;

    let candidate;
    let stillTaken = true;
    while (stillTaken) {
        const suffix = Math.floor(1000 + Math.random() * 9000);
        candidate = `${desiredName}#${suffix}`;
        const check = await pool.query(
            'SELECT 1 FROM users WHERE name = $1 AND key != $2',
            [candidate, userKey]
        );
        stillTaken = check.rows.length > 0;
    }
    return candidate;
}

// --- Badges d'achat (montant total cumulé) ---
const PURCHASE_BADGES = [
    { id: 'first',    threshold: 0,    name: 'Néophyte du Vide' },
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

// --- Badge de la Chasse au Rien (débloqué une fois, au premier succès) ---
const CHASE_BADGE = { id: 'chase', name: 'Chasseur du Vide' };

// --- Badges du Défi du Clic (nombre de clics en 5 secondes) ---
const CLICK_BADGES = [
    { id: 'c10',  threshold: 10,  name: 'Doigt Agité' },
    { id: 'c20',  threshold: 20,  name: 'Cliqueur Frénétique' },
    { id: 'c35',  threshold: 35,  name: 'Virtuose du Vide' },
    { id: 'c50',  threshold: 50,  name: 'Machine à Rien' }
];

function computeNewPurchaseBadges(user, isFirstPurchaseEver, currentBadges) {
    const unlocked = [];
    for (const badge of PURCHASE_BADGES) {
        const alreadyHas = currentBadges.includes(badge.id);
        const qualifies = badge.id === 'first' ? isFirstPurchaseEver : parseFloat(user.amount) >= badge.threshold;
        if (qualifies && !alreadyHas) {
            currentBadges.push(badge.id);
            unlocked.push(badge);
        }
    }
    return unlocked;
}

function computeNewVoidBadges(voidMaxSeconds, currentBadges) {
    const unlocked = [];
    for (const badge of VOID_BADGES) {
        if (voidMaxSeconds >= badge.threshold && !currentBadges.includes(badge.id)) {
            currentBadges.push(badge.id);
            unlocked.push(badge);
        }
    }
    return unlocked;
}

function computeNewClickBadges(clickBest, currentBadges) {
    const unlocked = [];
    for (const badge of CLICK_BADGES) {
        if (clickBest >= badge.threshold && !currentBadges.includes(badge.id)) {
            currentBadges.push(badge.id);
            unlocked.push(badge);
        }
    }
    return unlocked;
}

function highestBadgeName(purchaseBadgeIds) {
    for (let i = PURCHASE_BADGES.length - 1; i >= 0; i--) {
        if (purchaseBadgeIds.includes(PURCHASE_BADGES[i].id)) return PURCHASE_BADGES[i].name;
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
            automatic_payment_methods: { enabled: true },
        });
        res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        console.error('Erreur Stripe complète :', error);
        res.status(500).send({ error: error.message });
    }
});

// Endpoint : génère le certificat PDF d'achat de Néant.
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

        doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60).lineWidth(2).stroke('#111111');

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
app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT key, name, amount, purchase_badges FROM users ORDER BY amount DESC LIMIT 20'
        );
        const leaderboard = result.rows.map(u => ({
            key: u.key,
            name: u.name,
            amount: parseFloat(u.amount),
            topBadge: highestBadgeName(u.purchase_badges || [])
        }));
        res.send(leaderboard);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Ajoute/met à jour un score au classement + calcule les badges d'achat
// nouvellement débloqués. Le montant vient toujours de Stripe.
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

        const existingCheck = await pool.query('SELECT 1 FROM users WHERE key = $1', [userKey]);
        const isFirstPurchaseEver = existingCheck.rows.length === 0;

        const user = await getOrCreateUser(userKey);
        const finalName = await makeUniquePseudo(desiredName, userKey);
        const newAmount = parseFloat(user.amount) + amountToAdd;
        const badgeIds = user.purchase_badges || [];

        const newBadges = computeNewPurchaseBadges({ amount: newAmount }, isFirstPurchaseEver, badgeIds);

        await pool.query(
            'UPDATE users SET name = $1, amount = $2, purchase_badges = $3 WHERE key = $4',
            [finalName, newAmount, JSON.stringify(badgeIds), userKey]
        );

        const result = await pool.query(
            'SELECT key, name, amount, purchase_badges FROM users ORDER BY amount DESC LIMIT 20'
        );
        const leaderboard = result.rows.map(u => ({
            key: u.key,
            name: u.name,
            amount: parseFloat(u.amount),
            topBadge: highestBadgeName(u.purchase_badges || [])
        }));

        res.send({ finalName, leaderboard, newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Enregistre le temps passé sur "l'écran du Vide" et calcule les badges
// de contemplation nouvellement débloqués.
app.post('/void-time', async (req, res) => {
    try {
        const { userKey, seconds } = req.body;

        if (!userKey || typeof seconds !== 'number' || seconds < 0) {
            return res.status(400).send({ error: 'Champs invalides.' });
        }

        const cappedSeconds = Math.min(Math.round(seconds), 21600);

        const user = await getOrCreateUser(userKey);
        const newMax = Math.max(user.void_max_seconds, cappedSeconds);
        const badgeIds = user.void_badges || [];

        const newBadges = computeNewVoidBadges(newMax, badgeIds);

        await pool.query(
            'UPDATE users SET void_max_seconds = $1, void_badges = $2 WHERE key = $3',
            [newMax, JSON.stringify(badgeIds), userKey]
        );

        res.send({ voidMaxSeconds: newMax, newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Enregistre la capture du bouton "Rien" et débloque le badge associé.
app.post('/chase-catch', async (req, res) => {
    try {
        const { userKey } = req.body;
        if (!userKey) {
            return res.status(400).send({ error: 'userKey manquant.' });
        }

        const user = await getOrCreateUser(userKey);
        const badgeIds = user.chase_badges || [];
        const newBadges = [];

        if (!badgeIds.includes(CHASE_BADGE.id)) {
            badgeIds.push(CHASE_BADGE.id);
            newBadges.push(CHASE_BADGE);
            await pool.query('UPDATE users SET chase_badges = $1 WHERE key = $2', [JSON.stringify(badgeIds), userKey]);
        }

        res.send({ newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Enregistre le score au Défi du Clic (nombre de clics en 5 secondes) et
// calcule les badges nouvellement débloqués.
app.post('/click-challenge', async (req, res) => {
    try {
        const { userKey, clicks } = req.body;

        if (!userKey || typeof clicks !== 'number' || clicks < 0) {
            return res.status(400).send({ error: 'Champs invalides.' });
        }

        // On plafonne à 200 clics/5s pour ignorer les valeurs absurdes envoyées manuellement.
        const cappedClicks = Math.min(Math.round(clicks), 200);

        const user = await getOrCreateUser(userKey);
        const newBest = Math.max(user.click_best, cappedClicks);
        const badgeIds = user.click_badges || [];

        const newBadges = computeNewClickBadges(newBest, badgeIds);

        await pool.query(
            'UPDATE users SET click_best = $1, click_badges = $2 WHERE key = $3',
            [newBest, JSON.stringify(badgeIds), userKey]
        );

        res.send({ clickBest: newBest, newBadges });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Renvoie le catalogue complet des badges avec l'état débloqué/verrouillé
// pour cet utilisateur, ainsi que sa progression actuelle.
app.get('/my-badges', async (req, res) => {
    try {
        const userKey = req.query.userKey;
        if (!userKey) {
            return res.status(400).send({ error: 'userKey manquant.' });
        }

        const result = await pool.query('SELECT * FROM users WHERE key = $1', [userKey]);
        const user = result.rows[0] || {
            amount: 0, purchase_badges: [], void_max_seconds: 0, void_badges: [],
            chase_badges: [], click_best: 0, click_badges: []
        };

        const purchase = PURCHASE_BADGES.map(b => ({
            id: b.id, name: b.name, threshold: b.threshold,
            unlocked: (user.purchase_badges || []).includes(b.id)
        }));

        const voidCat = VOID_BADGES.map(b => ({
            id: b.id, name: b.name, threshold: b.threshold,
            unlocked: (user.void_badges || []).includes(b.id)
        }));

        const chase = [{
            id: CHASE_BADGE.id, name: CHASE_BADGE.name,
            unlocked: (user.chase_badges || []).includes(CHASE_BADGE.id)
        }];

        const click = CLICK_BADGES.map(b => ({
            id: b.id, name: b.name, threshold: b.threshold,
            unlocked: (user.click_badges || []).includes(b.id)
        }));

        res.send({
            amount: parseFloat(user.amount),
            voidMaxSeconds: user.void_max_seconds,
            clickBest: user.click_best,
            purchase,
            void: voidCat,
            chase,
            click
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// Render attribue un port dynamiquement via process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
