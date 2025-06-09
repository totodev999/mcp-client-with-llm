import dotenv from 'dotenv';
import { Pool } from 'pg';
import { CoreMessage } from 'ai';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.CONNECTION_STRING,
});

type ChatHistory = {
  id: string;
  messages: CoreMessage[];
};

export const getConversation = async (id: string) => {
  try {
    const client = await pool.connect();
    const result = (
      await client.query<ChatHistory>('SELECT * FROM messages where id = $1;', [
        id,
      ])
    ).rows?.[0];
    console.log('getConversation', result);
    return result ? result : undefined;
  } catch (err) {
    console.error('Fetch DB failed', err);
    throw err;
  }
};

export const upsertConversation = async (
  id: string | undefined,
  messages: CoreMessage[]
): Promise<string> => {
  try {
    const client = await pool.connect();
    if (id) {
      const result = (
        await client.query<never>(
          'UPDATE messages set messages = $1 where id = $2;',
          [JSON.stringify(messages), id]
        )
      ).rows[0];
      console.log('upsertConversation UPDATE', id);
      return id;
    } else {
      const result = (
        await client.query<{ id: string }>(
          'INSERT INTO messages (messages) VALUES($1) returning id;',
          [JSON.stringify(messages)]
        )
      ).rows[0];
      console.log('upsertConversation INSERT', id);
      return result.id;
    }
  } catch (err) {
    console.error('Fetch DB failed', err);
    throw err;
  }
};
