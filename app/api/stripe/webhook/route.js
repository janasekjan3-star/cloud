import Stripe from 'stripe';
import { db } from '../../../../lib/db';

export const dynamic = 'force-dynamic';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) return new Response('Webhook není nakonfigurován.', { status: 400 });
  const body = await request.text();
  let event;
  try { event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { console.error('Stripe signature error', error); return new Response('Invalid signature', { status: 400 }); }

  const sql = db();
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const reservationId = session.metadata?.reservationId || session.client_reference_id;
      if (reservationId && session.payment_status === 'paid') {
        const existing = await sql`SELECT id FROM orders WHERE stripe_session_id=${session.id} LIMIT 1`;
        if (!existing.length) {
          const reservation = await sql`SELECT id,total_amount,name,email,status FROM reservations WHERE id=${reservationId} LIMIT 1`;
          if (reservation.length && reservation[0].status !== 'paid') {
            await sql`INSERT INTO orders (reservation_id,stripe_session_id,payment_intent_id,amount,currency,customer_name,customer_email,status) VALUES (${reservationId},${session.id},${session.payment_intent || null},${Number(session.amount_total || reservation[0].total_amount)},${session.currency || 'czk'},${reservation[0].name},${reservation[0].email},'paid') ON CONFLICT (stripe_session_id) DO NOTHING`;
            await sql`UPDATE reservations SET status='paid',updated_at=now() WHERE id=${reservationId}`;
            await sql`UPDATE cells SET status='sold',reserved_until=NULL,order_id=(SELECT id FROM orders WHERE stripe_session_id=${session.id}) WHERE reservation_id=${reservationId}`;
          }
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const reservationId = session.metadata?.reservationId || session.client_reference_id;
      if (reservationId) {
        await sql`UPDATE cells SET status='available',reservation_id=NULL,reserved_until=NULL WHERE reservation_id=${reservationId} AND status='reserved'`;
        await sql`UPDATE reservations SET status='expired',updated_at=now() WHERE id=${reservationId} AND status='pending'`;
      }
    }

    return Response.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error', error);
    return new Response('Webhook processing failed', { status: 500 });
  }
}
