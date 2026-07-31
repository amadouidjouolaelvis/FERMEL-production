/**
 * FERMEL — FedaPay return/callback.
 *
 * The query-string status is NOT trusted. We retrieve the transaction
 * directly from FedaPay and only then mark the matching order as paid.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_ENV = process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

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
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return data;
}

async function fedapay(path) {
  const base = FEDAPAY_ENV === 'live'
    ? 'https://api.fedapay.com/v1'
    : 'https://sandbox-api.fedapay.com/v1';

  const response = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${FEDAPAY_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`FedaPay ${response.status}: ${text}`);
  return data;
}

function redirect(status, orderId = '') {
  const qs = new URLSearchParams({ payment: status });
  if (orderId) qs.set('order', orderId);
  return {
    statusCode: 302,
    headers: {
      Location: `${SITE_URL}/?${qs.toString()}`,
      'Cache-Control': 'no-store'
    },
    body: ''
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FEDAPAY_SECRET_KEY || !SITE_URL) {
    return { statusCode: 500, body: 'Payment service is not configured' };
  }

  try {
    const params = event.queryStringParameters || {};
    const transactionId = Number(params.id);
    if (!Number.isInteger(transactionId) || transactionId <= 0) return redirect('error');

    const tx = await fedapay(`/transactions/${transactionId}`);
    const metadata = tx.custom_metadata || tx.metadata || {};
    const orderId = metadata.order_id || '';

    if (!orderId) return redirect('error');

    const orders = await supabaseRest(
      `orders?id=eq.${encodeURIComponent(orderId)}&select=id,total_xof,payment_transaction_id,status`
    );
    const order = orders?.[0];
    if (!order) return redirect('error');

    if (Number(order.payment_transaction_id) !== transactionId) {
      return redirect('error', orderId);
    }

    const providerStatus = String(tx.status || '').toLowerCase();
    const approved = providerStatus === 'approved';

    if (approved) {
      await supabaseRest(`orders?id=eq.${encodeURIComponent(orderId)}&status=neq.paid`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'paid',
          paid_at: new Date().toISOString()
        })
      });
    }

    await supabaseRest('payment_events', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=ignore-duplicates,return=minimal'
      },
      body: JSON.stringify({
        provider: 'fedapay',
        provider_event_id: `callback-${transactionId}-${providerStatus}`,
        order_id: orderId,
        status: providerStatus,
        payload: tx
      })
    });

    if (approved) return redirect('success', orderId);
    if (providerStatus === 'canceled' || providerStatus === 'declined') {
      return redirect('cancelled', orderId);
    }
    return redirect('pending', orderId);
  } catch (error) {
    console.error('[FERMEL payment-callback]', error);
    return redirect('error');
  }
};
