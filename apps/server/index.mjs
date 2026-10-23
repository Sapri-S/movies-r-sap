import { createApp } from './app.mjs';

const rawPort = process.env.PORT || '4173';
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error('PORT must be a number between 1 and 65535.');
  process.exitCode = 1;
} else {
  let app;
  try {
    app = await createApp({ ...(process.env.MOVIES_DATA_DIR ? { dataDir: process.env.MOVIES_DATA_DIR } : {}) });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(Number(rawPort), '127.0.0.1', resolve);
    });
    console.log(`\nMovies R Sap is ready at http://127.0.0.1:${rawPort}`);
    console.log(`Library: ${app.dataDir}`);
    console.log('Keep this terminal open while watching. Press Ctrl+C to stop.\n');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\nClosing your library…');
      try { await app.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    app.server.on('error', (error) => { console.error('Local server error:', error.message); void stop(); });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${rawPort} is already in use. Close the other app or set PORT to another number.` : `Movies R Sap could not start: ${error.message}`);
    if (app) await app.close();
    process.exitCode = 1;
  }
}
