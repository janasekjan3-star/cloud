import { db } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sql = db();
    const rows = await sql`SELECT id, status FROM cells WHERE status <> 'available' AND (status = 'sold' OR reserved_until > now()) ORDER BY id`;
    return Response.json({ sold: rows.filter(r => r.status === 'sold').map(r => r.id), reserved: rows.filter(r => r.status === 'reserved').map(r => r.id) });
  } catch (error) {
    console.error(error);
    return Response.json({ error: 'Nepodařilo se načíst stav polí.' }, { status: 500 });
  }
}
