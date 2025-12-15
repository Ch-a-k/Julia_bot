import express from 'express';
import { config } from './config.js';

export function startServer(): void {
  const app = express();

  app.get('/health', (_req, res) => res.send('ok'));

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on :${config.port}`);
  });
}

