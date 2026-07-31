// Netlify Function — point d'entrée webhook FedaPay.
// Ne valider une commande qu'après vérification du statut côté serveur.
// Ajouter ici la vérification de signature/événement selon la configuration FedaPay.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const payload = JSON.parse(event.body || '{}');

    // TODO:
    // - Vérifier l'authenticité de l'événement.
    // - Utiliser provider_event_id comme clé d'idempotence.
    // - Récupérer la transaction fournisseur.
    // - Si status = approved, passer orders.status à paid.
    // - Insérer payment_events.
    // - Ne jamais créditer deux fois une même commande.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload' }) };
  }
};
