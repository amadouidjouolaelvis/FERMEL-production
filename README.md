# FERMEL — préparation production

Ce dossier part du prototype HTML fourni et le prépare pour une architecture publique.

## Architecture recommandée

- Frontend : HTML/CSS/JavaScript, déployé sur Netlify.
- Auth + PostgreSQL : Supabase Auth + Postgres.
- Sécurité : Row Level Security (RLS) + fonctions SQL atomiques.
- Paiements : FedaPay côté serveur, d'abord en sandbox puis en live.
- Domaine : un domaine `.bj` ou `.com` selon disponibilité.
- Administration : rôle `admin` dans `profiles`, avec pages protégées.

## Ce qui a été corrigé dans cette version

1. Le fichier est renommé `public/index.html`.
2. Le titre et les métadonnées sont préparés pour FERMEL.
3. Le nom visible de l'application est uniformisé en FERMEL.
4. Une erreur de copie dans l'historique des conversations a été corrigée.
5. Le schéma de base de données est fourni dans `supabase/schema.sql`.
6. Le parrainage est conçu côté serveur : **200 FCFA de crédit boost par filleul validé**, sans ajout au solde bancaire.
7. Le crédit de boost ne peut pas être directement modifié par le navigateur ; l'utilisation passe par une fonction SQL atomique.
8. Les clés secrètes de paiement sont prévues côté serveur.

## Mise en route

### 1. Supabase

Créer un projet Supabase, puis exécuter `supabase/schema.sql` dans SQL Editor.

Activer l'authentification e-mail + mot de passe.

Créer un premier compte administrateur, puis lui attribuer le rôle `admin` dans `profiles` via SQL après création :

```sql
update public.profiles
set role = 'admin'
where id = 'UUID_DU_COMPTE_ADMIN';
```

Ne pas exposer la clé `service_role`.

### 2. Frontend

Le prototype actuel n'est pas encore branché à Supabase. Il faut remplacer ses fonctions de stockage local `window.storage` par Supabase Auth/Database.

Flux recommandé :

- inscription : `supabase.auth.signUp()`
- création du profil : RPC `create_profile(...)`
- connexion : `supabase.auth.signInWithPassword()`
- déconnexion : `supabase.auth.signOut()`
- session : `supabase.auth.getSession()` / `onAuthStateChange()`
- mot de passe oublié : `supabase.auth.resetPasswordForEmail()`

### 3. Parrainage

Le code de parrainage est transmis à `create_profile()`. Le serveur :

- vérifie le code ;
- refuse l'auto-parrainage ;
- empêche le double crédit ;
- crédite exactement 200 FCFA ;
- écrit une ligne dans `boost_ledger`.

Les 200 FCFA sont exclusivement des crédits de boost et ne sont ni retirables ni transférables.

### 4. Paiements

Créer d'abord les commandes en statut `pending`.

Le navigateur appelle une fonction serveur `create-payment`, qui utilise la clé secrète FedaPay. Le paiement doit être confirmé côté serveur avant de passer la commande à `paid`.

Ne jamais considérer un simple retour du navigateur comme une preuve de paiement.

### 5. Déploiement Netlify

Pousser le projet dans GitHub, puis importer le dépôt dans Netlify.

Paramètres :
- Publish directory : `public`
- Functions directory : `netlify/functions`

Ajouter les variables secrètes dans les paramètres Netlify.

### 6. Domaine

Une fois le site en ligne, ajouter le domaine personnalisé dans Netlify et configurer les DNS du registrar.

Pour un domaine béninois, vérifier la disponibilité et les conditions sur le registre `.bj`.

## Important

Cette archive est une base de préparation technique. Les étapes nécessitant des comptes externes, des clés API, une vérification marchand ou l'achat d'un domaine ne peuvent pas être exécutées automatiquement sans accès aux comptes concernés.

Avant l'ouverture au public, faire un test complet en sandbox : inscription, connexion, parrainage, boost, commande, paiement refusé, paiement réussi, webhook, administration et déconnexion.

## Paiements FedaPay — intégré

Le projet contient maintenant un flux de paiement FedaPay :

1. Le client sélectionne des produits.
2. Le navigateur envoie seulement les `product_id` et les quantités.
3. `create-payment` vérifie la session Supabase.
4. Le serveur recharge les prix depuis PostgreSQL et calcule le total.
5. La commande est créée en `pending`.
6. FERMEL crée une transaction FedaPay en XOF.
7. FedaPay fournit une URL de paiement sécurisée.
8. Le client est redirigé vers FedaPay.
9. `payment-callback` récupère la transaction directement auprès de FedaPay.
10. La commande devient `paid` uniquement si FedaPay renvoie `approved`.

La page de retour ne fait jamais confiance au paramètre `status` de l'URL.

### Variables Netlify à renseigner

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` **(secret)**
- `FEDAPAY_SECRET_KEY` **(secret)**
- `FEDAPAY_ENV=sandbox` pour les tests
- `SITE_URL=https://...`

Ne mettez jamais `SUPABASE_SERVICE_ROLE_KEY` ou `FEDAPAY_SECRET_KEY` dans `public/`.

### FedaPay

L'API FedaPay utilise des transactions en XOF et permet de générer ensuite un lien de paiement pour la transaction. La documentation indique aussi que le retour `callback_url` ne doit pas être considéré seul comme une preuve de paiement : FERMEL vérifie donc directement la transaction côté serveur.

Pour commencer, utilisez le mode `sandbox`. Passez à `live` uniquement après validation des tests.

## Étapes 3 + 4 — Supabase + authentification réelle

### 1. Créer le projet Supabase
Dans Supabase, créez un projet PostgreSQL puis ouvrez **SQL Editor**.

### 2. Installer la base
Copiez tout le contenu de `supabase/schema.sql` dans SQL Editor et exécutez-le.

Le schéma crée notamment :
- `profiles`
- `referrals`
- `boost_ledger`
- `wallet_transactions`
- `products`
- `orders`
- `order_items`
- `posts`
- `payment_events`

Il active aussi RLS et crée le trigger qui crée automatiquement le profil après une inscription Supabase Auth.

### 3. Activer l'authentification
Dans Supabase :
- Authentication → Providers → Email
- activez Email/Password
- vous pouvez garder la confirmation e-mail activée pour la production.

### 4. Configurer FERMEL
Copiez :
`public/supabase-config.example.js`
vers :
`public/supabase-config.js`

Puis renseignez :
- `FERMEL_SUPABASE_URL`
- `FERMEL_SUPABASE_PUBLISHABLE_KEY`

Ne mettez jamais la `service_role` key dans ce fichier.

### 5. Inscription
FERMEL utilise désormais `supabase.auth.signUp()`.
Le mot de passe est géré par Supabase Auth et n'est plus enregistré dans FERMEL.

Les métadonnées :
- nom
- téléphone
- code de parrainage

sont transmises à Supabase Auth puis le trigger crée le profil.

### 6. Connexion
FERMEL utilise `supabase.auth.signInWithPassword()` et restaure automatiquement la session au chargement.

### 7. Parrainage
Le code de parrainage est validé côté PostgreSQL.
Un filleul valide déclenche une seule récompense de **200 FCFA de crédit BOOST**.
Le crédit est interne à FERMEL :
- non retirable
- non transférable
- non convertible en solde bancaire.

### 8. Déploiement Netlify
Le fichier `public/supabase-config.js` doit être présent au moment du déploiement avec les valeurs publiques du projet Supabase.

Les secrets serveur comme :
`SUPABASE_SERVICE_ROLE_KEY`
 et
`FEDAPAY_SECRET_KEY`
 restent dans les variables d'environnement Netlify.

