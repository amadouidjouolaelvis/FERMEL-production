/**
 * FERMEL — Create a FedaPay payment.
 *
 * Security model:
 * - The browser sends only product IDs + quantities.
 * - The Supabase access token identifies the authenticated user.
 * - Product prices are reloaded from Supabase on the server.
 * - The order total is therefore NOT trusted from the browser.
 * - The FedaPay secret key is server-only.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_ENV = process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

async function supabaseRest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function getAuthUser(accessToken) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) return null;
  return response.json();
}

async function fedapay(path, options = {}) {
  const base = FEDAPAY_ENV === 'live'
    ? 'https://api.fedapay.com/v1'
    : 'https://sandbox-api.fedapay.com/v1';

  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${FEDAPAY_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`FedaPay ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SERVICE_ROLE_KEY ||
      !FEDAPAY_SECRET_KEY || !SITE_URL) {
    return json(500, { error: 'Payment service is not configured' });
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!accessToken) return json(401, { error: 'Authentication required' });

  try {
    const user = await getAuthUser(accessToken);
    if (!user?.id) return json(401, { error: 'Invalid or expired session' });

    const body = JSON.parse(event.body || '{}');
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const items = rawItems
      .map(item => ({
        product_id: Number(item.product_id),
        quantity: Number(item.quantity)
      }))
      .filter(item => Number.isInteger(item.product_id) &&
                         Number.isInteger(item.quantity) &&
                         item.quantity > 0 &&
                         item.quantity <= 99);

    if (!items.length || items.length > 50) {
      return json(400, { error: 'Panier invalide' });
    }

    const uniqueIds = [...new Set(items.map(i => i.product_id))];
    const ids = uniqueIds.join(',');
    const products = await supabaseRest(
      `products?id=in.(${encodeURIComponent(ids)})&active=eq.true&select=id,name,price_xof`
    );

    const byId = new Map((products || []).map(p => [Number(p.id), p]));
    if (byId.size !== uniqueIds.length) {
      return json(400, { error: 'Un produit du panier est indisponible' });
    }

    const normalized = items.map(item => {
      const product = byId.get(item.product_id);
      return {
        product_id: product.id,
        quantity: item.quantity,
        unit_price_xof: Number(product.price_xof),
        name: product.name
      };
    });

    const total = normalized.reduce(
      (sum, item) => sum + item.unit_price_xof * item.quantity, 0
    );

    if (!Number.isInteger(total) || total <= 0) {
      return json(400, { error: 'Montant de commande invalide' });
    }

    const profiles = await supabaseRest(
      `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,full_name,phone`
    );
    const profile = profiles?.[0];
    if (!profile) return json(400, { error: 'Profil FERMEL introuvable' });

    const rpcResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_order_from_cart`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_items: normalized.map(i => ({
        product_id: i.product_id,
        quantity: i.quantity
      })) })
    });
    const rpcText = await rpcResponse.text();
    let order = null;
    try { order = rpcText ? JSON.parse(rpcText) : null; } catch {}
    if (!rpcResponse.ok || !order?.id) {
      throw new Error(`create_order_from_cart failed: ${rpcText}`);
    }

    const merchantReference = `FERMEL-${order.id}`;

    const transaction = await fedapay('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        description: `Commande FERMEL ${merchantReference}`,
        amount: total,
        currency: { iso: 'XOF' },
        callback_url: `${SITE_URL}/.netlify/functions/payment-callback`,
        merchant_reference: merchantReference,
        custom_metadata: {
          order_id: order.id,
          user_id: user.id,
          app: 'FERMEL'
        },
        customer: {
          email: user.email,
          firstname: profile.full_name?.split(/\s+/)[0] || 'Client',
          lastname: profile.full_name?.split(/\s+/).slice(1).join(' ') || 'FERMEL'
        }
      })
    });

    const transactionId = transaction.id;
    const reference = transaction.reference || merchantReference;

    const tokenData = await fedapay(`/transactions/${transactionId}/token`, {
      method: 'POST'
    });

    if (!tokenData?.url) throw new Error('FedaPay payment URL not returned');

    await supabaseRest(`orders?id=eq.${encodeURIComponent(order.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        payment_provider: 'fedapay',
        payment_reference: reference,
        payment_transaction_id: transactionId,
        payment_url: tokenData.url
      })
    });

    return json(200, {
      ok: true,
      orderId: order.id,
      paymentUrl: tokenData.url,
      status: transaction.status || 'pending',
      environment: FEDAPAY_ENV
    });
  } catch (error) {
    console.error('[FERMEL create-payment]', error);
    return json(500, { error: 'Impossible de créer le paiement', detail: 'Payment initialization failed' });
  }
};
