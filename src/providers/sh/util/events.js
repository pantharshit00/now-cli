// Packages
const chalk = require('chalk')
const { eraseLines } = require('ansi-escapes')
const jsonlines = require('jsonlines')
const retry = require('async-retry')

// Utilities
const createOutput = require('../../../util/output')

async function printEvents(now, deploymentIdOrURL, currentTeam = null, {
  mode, printEvent, onOpen = ()=>{}, quiet, debugEnabled, findOpts
} = {}) {
  const { log, debug } = createOutput({ debug: debugEnabled })

  let onOpenCalled = false
  function callOnOpenOnce() {
    if (onOpenCalled) return
    onOpenCalled = true
    onOpen()
  }

  const query = findOpts.query || ''
  const types = (findOpts.types || []).join(',')
  const follow = findOpts.follow ? '1' : ''
  let eventsUrl = `/v1/now/deployments/${deploymentIdOrURL}/events?query=${query}&types=${types}&follow=${follow}&format=lines`
  let pollUrl = `/v3/now/deployments/${deploymentIdOrURL}`

  if (currentTeam) {
    eventsUrl += `&teamId=${currentTeam.id}`
    pollUrl += `?teamId=${currentTeam.id}`
  }

  debug(`Events ${eventsUrl}`)

  // we keep track of how much we log in case we
  // drop the connection and have to start over
  let o = 0

  await retry(async (bail, attemptNumber) => {
    if (attemptNumber > 1) {
      debug('Retrying events')
    }

    const eventsRes = await now._fetch(eventsUrl)
    if (eventsRes.ok) {
      const readable = await eventsRes.readable()

      // handle the event stream and make the promise get rejected
      // if errors occur so we can retry
      return new Promise((resolve, reject) => {
        const stream = readable.pipe(jsonlines.parse())

        let poller;

        if (mode === 'deploy') {
          poller = (function startPoller() {
            return setTimeout(async () => {
              try {
                const pollRes = await now._fetch(pollUrl)
                if (!pollRes.ok) throw new Error(`Response ${pollRes.status}`)
                const json = await pollRes.json()
                if (json.state === 'READY') {
                  finish()
                  return
                }
                poller = startPoller()
              } catch (error) {
                finish(error)
              }
            }, 5000)
          })()
        }

        let finishCalled = false
        function finish(error) {
          if (finishCalled) return
          finishCalled = true
          callOnOpenOnce()

          if (mode === 'deploy') {
            if (!error) log(chalk`{cyan Success!} Build complete`)
          }

          clearTimeout(poller)
          // avoid lingering events
          stream.removeListener('data', onData)
          // prevent partial json from being parsed and error emitted.
          // this can be reproduced by force placing stream.write('{{{') here
          stream._emitInvalidLines = true
          // close the stream and resolve
          stream.end()
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }

        const onData = (data) => {
          const { event } = data;
          if (event === 'build-complete') {
            if (mode === 'deploy') {
              finish()
            }
          } else {
            o += printEvent(data, callOnOpenOnce)
          }
        }

        stream.on('end', finish)
        stream.on('data', onData)
        stream.on('error', err => {
          o++
          callOnOpenOnce()
          log(`Deployment event stream error: ${err.message}`)
        })
      })
    } else {
      callOnOpenOnce()
      const err = new Error(`Deployment events status ${eventsRes.status}`)

      if (eventsRes.status < 500) {
        bail(err)
      } else {
        throw err
      }
    }
  }, {
    retries: 4,
    onRetry: (err) => {
      // if we are retrying, we clear past logs
      if (!quiet && o) {
        // o + 1 because current line is counted
        process.stdout.write(eraseLines(o + 1))
        o = 0
      }

      log(`Deployment state polling error: ${err.message}`)
    }
  })
}

module.exports = printEvents