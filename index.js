import stateManager from './stateManager.js';
import saveDocs from './saveDocs.js';
import algoliaIndex from './algoliaIndex.js';
import c from './config.js';
import PouchDB from 'pouchdb-http';
import npm from './npm.js';
import log from './log.js';
import ms from 'ms';
import '@risingstack/trace';

log.info('🗿 npm ↔️ Algolia replication starts ⛷ 🐌 🛰');

const db = new PouchDB(c.npmRegistryEndpoint);
const defaultOptions = {
  include_docs: true, // eslint-disable-line camelcase
  conflicts: false,
  attachments: false,
};

let loopStart = Date.now();

algoliaIndex
  .setSettings(c.indexSettings)
  .then(({taskID}) => algoliaIndex.waitTask(taskID))
  .then(() => stateManager.check())
  .then(bootstrap)
  .then(() => stateManager.get())
  .then(replicate)
  .then(() => stateManager.get())
  .then(watch)
  .catch(error);

function infoChange(seq, nbChanges, emoji) {
  return npm
    .info()
    .then(npmInfo => {
      const ratePerSecond = nbChanges / ((Date.now() - loopStart) / 1000);
      log.info(
        `${emoji} Synced %d/%d changes (%d%), current rate: %d changes/s (%s remaining)`,
        seq,
        npmInfo.seq,
        Math.floor(Math.max(seq, 1) / npmInfo.seq * 100),
        Math.round(ratePerSecond),
        ms((npmInfo.seq - seq) / ratePerSecond * 1000)
      );
      loopStart = Date.now();
    });
}

function infoDocs(offset, nbDocs, emoji) {
  return npm
    .info()
    .then(({nbDocs: totalDocs}) => {
      const ratePerSecond = nbDocs / ((Date.now() - loopStart) / 1000);
      log.info(
        `${emoji} Synced %d/%d docs (%d%), current rate: %d docs/s (%s remaining)`,
        offset + nbDocs,
        totalDocs,
        Math.floor(Math.max(offset + nbDocs, 1) / totalDocs * 100),
        Math.round(ratePerSecond),
        ms((totalDocs - offset - nbDocs) / ratePerSecond * 1000)
      );
      loopStart = Date.now();
    });
}

function bootstrap(state) {
  if (state.seq > 0 && state.bootstrapDone === true) {
    log.info('⛷ Bootstrap: done');
    return state;
  }

  if (state.bootstrapLastId) {
    log.info('⛷ Bootstrap: starting at doc %s', state.bootstrapLastId);
    return loop(state.bootstrapLastId);
  } else {
    log.info('⛷ Bootstrap: starting from the first doc');
    return npm
      .info()
      // first time this launches, we need to remember the last seq our bootstrap can trust
      .then(({seq}) => stateManager.save({seq}))
      .then(() => loop(state.bootstrapLastId));
  }

  function loop(lastId) {
    const options = lastId === undefined ? {} : {startkey: lastId, skip: 1};

    return db
      .allDocs({
        ...defaultOptions,
        ...options,
        limit: c.bootstrapConcurrency,
      })
      .then(res => {
        if (res.rows.length === 0) {
          log.info('⛷ Bootstrap: done');
          return stateManager.save({bootstrapDone: true});
        }

        const newLastId = res.rows[res.rows.length - 1].id;

        return saveDocs(res.rows)
          .then(() => stateManager.save({bootstrapLastId: newLastId}))
          .then(() => infoDocs(res.offset, res.rows.length, '⛷'))
          .then(() => loop(newLastId));
      });
  }
}

function replicate({seq}) {
  log.info('🐌 Replicate: Asking for %d changes since sequence %d', c.replicateConcurrency, seq);

  return db
    .changes({
      ...defaultOptions,
      since: seq,
      limit: c.replicateConcurrency,
    })
    .then(res =>
      saveDocs(res.results)
      .then(() => stateManager.save({seq: res.last_seq}))
      .then(() => infoChange(res.last_seq, res.results.length, '🐌'))
      .then(() => {
        if (res.results.length < c.replicateConcurrency) {
          log.info('🐌 Replicate: done');
          return true;
        }

        return replicate({seq: res.last_seq});
      })
    );
}

function watch({seq}) {
  log.info('🛰 Watch: 👍 We are in sync (or almost). Will now be 🔭 watching for registry updates');

  let chain = Promise.resolve();

  return new Promise((resolve, reject) => {
    const changes = db.changes({
      ...defaultOptions,
      since: seq,
      live: true,
      limit: undefined,
    });

    changes.on('change', change => {
      chain = chain
        .then(() => saveDocs([change]), reject)
        .then(() => infoChange(change.seq, 1, '🛰'))
        .then(() => stateManager.save({seq: change.seq}))
        .catch(reject);
    });
    changes.on('error', reject);
  });
}

function error(err) {
  console.error(err); // eslint-disable-line no-console
  process.exit(1); // eslint-disable-line no-process-exit
}
