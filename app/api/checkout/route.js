import Stripe from 'stripe';
import { db } from '../../../lib/db';

export const dynamic = 'force-dynamic';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Neplatná data.' }, { status: 400 }); }
  const ids = [...new Set((body.cellIds || []).map(Number).filter(Number.isInteger))];
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const message = String(body.message || '').trim().slice(0, 1000);
  const imageData = typeof body.imageData === 'string' && body.imageData.length < 7_000_000 ? body.imageData : null;
  if (!ids.length || ids.length > 5000) return Response.json({ error: 'Vyber 1–5000 polí.' }, { status: 400 });
  if (!name || !email || !email.includes('@')) return Response.json({ error: 'Vyplň jméno a platný e-mail.' }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.NEXT_PUBLIC_BASE_URL) return Response.json({ error: 'Platby nejsou ještě nakonfigurované.' }, { status: 503 });

  const sql = db();
  const reservationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  try {
    await sql`INSERT INTO reservations (id,name,email,message,image_data,total_amount,expires_at) VALUES (${reservationId},${name},${email},${message || null},${imageData},0,${expiresAt.toISOString()})`;
    const rows = await sql`UPDATE cells SET status='reserved',reservation_id=${reservationId},reserved_until=${expiresAt.toISOString()} WHERE id = ANY(${ids}) AND (status='available' OR (status='reserved' AND reserved_until < now())) RETURNING id,price`;
    if (rows.length !== ids.length) {
      await sql`UPDATE cells SET status='available',reservation_id=NULL,reserved_until=NULL WHERE reservation_id=${reservationId}`;
      await sql`UPDATE reservations SET status='cancelled',updated_at=now() WHERE id=${reservationId}`;
      return Response.json({ error: 'Některá vybraná pole už nejsou dostupná. Obnov stránku a vyber je znovu.' }, { status: 409 });
    }
    const total = rows.reduce((sum, row) => sum + Number(row.price), 0);
    await sql`UPDATE reservations SET total_amount=${total},updated_at=now() WHERE id=${reservationId}`;
    await sql`INSERT INTO reservation_cells (reservation_id,cell_id) SELECT ${reservationId}, id FROM cells WHERE reservation_id=${reservationId}`;

    const session = await stripe.checkout.sessions.create({
      mode:'payment', payment_method_types:['card'], customer_email:email, client_reference_id:reservationId,
      line_items:[{price_data:{currency:'czk',product_data:{name:`100K Mosaic – ${ids.length} polí`},unit_amount:total*100},quantity:1}],
      metadata:{reservationId,cellCount:String(ids.length)}, expires_at:Math.floor(expiresAt.getTime()/1000),
      success_url:`${process.env.NEXT_PUBLIC_BASE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${process.env.NEXT_PUBLIC_BASE_URL}/?payment=cancelled`,
    });
    await sql`UPDATE reservations SET stripe_session_id=${session.id},updated_at=now() WHERE id=${reservationId}`;
    return Response.json({url:session.url,reservationId,expiresAt:expiresAt.toISOString(),total});
  } catch (error) {
    console.error(error);
    try { await sql`UPDATE cells SET status='available',reservation_id=NULL,reserved_until=NULL WHERE reservation_id=${reservationId}`; await sql`UPDATE reservations SET status='cancelled',updated_at=now() WHERE id=${reservationId}`; } catch {}
    return Response.json({error:'Checkout se nepodařilo vytvořit.'},{status:500});
  }
}
