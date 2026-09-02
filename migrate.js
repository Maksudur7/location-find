require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const client = await pool.connect();
  try {
    console.log('Cleaning duplicate session_ids...');

    // Delete duplicates keeping latest per session_id
    await client.query(`
      DELETE FROM visitors
      WHERE id NOT IN (
        SELECT DISTINCT ON (session_id) id
        FROM visitors
        ORDER BY session_id, visit_time DESC
      )
    `);

    // Delete rows with null session_id
    await client.query(`DELETE FROM visitors WHERE session_id IS NULL`);

    // Now add unique constraint safely
    await client.query(`
      ALTER TABLE visitors DROP CONSTRAINT IF EXISTS visitors_session_id_key;
      ALTER TABLE visitors ADD CONSTRAINT visitors_session_id_key UNIQUE (session_id);
    `);

    const r = await client.query('SELECT COUNT(*) FROM visitors');
    console.log('✅ Migration done. Rows remaining:', r.rows[0].count);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    client.release();
    process.exit(0);
  }
})();
