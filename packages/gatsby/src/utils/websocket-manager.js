// @flow

const path = require(`path`)
const { store } = require(`../redux`)
const fs = require(`fs`)

type QueryResult = {
  id: string,
  result: object,
}

type QueryResultsMap = Map<string, QueryResult>

/**
 * Get cached query result for given data path.
 * @param {string} dataFileName Cached query result filename.
 * @param {string} directory Root directory of current project.
 */
const readCachedResults = (dataFileName: string, directory: string): object => {
  const filePath = path.join(
    directory,
    `public`,
    `static`,
    `d`,
    `${dataFileName}.json`
  )
  return JSON.parse(fs.readFileSync(filePath, `utf-8`))
}

/**
 * Get cached page query result for given page path.
 * @param {string} pagePath Path to a page.
 * @param {string} directory Root directory of current project.
 */
const getCachedPageData = (
  pagePath: string,
  directory: string
): QueryResult => {
  const { jsonDataPaths, pages } = store.getState()
  const page = pages.get(pagePath)
  const dataPath = jsonDataPaths[page.jsonName]
  if (typeof dataPath === `undefined`) {
    console.log(
      `Error loading a result for the page query in "${pagePath}". Query was not run and no cached result was found.`
    )
    return undefined
  }

  return {
    result: readCachedResults(dataPath, directory),
    id: pagePath,
  }
}

/**
 * Get cached StaticQuery results for components that Gatsby didn't run query yet.
 * @param {QueryResultsMap} resultsMap Already stored results for queries that don't need to be read from files.
 * @param {string} directory Root directory of current project.
 */
const getCachedStaticQueryResults = (
  resultsMap: QueryResultsMap,
  directory: string
): QueryResultsMap => {
  const cachedStaticQueryResults = new Map()
  const { staticQueryComponents, jsonDataPaths } = store.getState()
  staticQueryComponents.forEach(staticQueryComponent => {
    // Don't read from file if results were already passed from query runner
    if (resultsMap.has(staticQueryComponent.hash)) return

    const dataPath = jsonDataPaths[staticQueryComponent.jsonName]
    if (typeof dataPath === `undefined`) {
      console.log(
        `Error loading a result for the StaticQuery in "${
          staticQueryComponent.componentPath
        }". Query was not run and no cached result was found.`
      )
      return
    }
    cachedStaticQueryResults.set(staticQueryComponent.hash, {
      result: readCachedResults(dataPath, directory),
      id: staticQueryComponent.hash,
    })
  })
  return cachedStaticQueryResults
}

const getRoomNameFromPath = (path: string): string => `path-${path}`

class WebsocketManager {
  pageResults: QueryResultsMap
  staticQueryResults: QueryResultsMap
  isInitialised: boolean
  activePaths: Set<string>
  programDir: string

  constructor() {
    this.isInitialised = false
    this.activePaths = new Set()
    this.pageResults = new Map()
    this.staticQueryResults = new Map()
    this.websocket
    this.programDir

    this.init = this.init.bind(this)
    this.getSocket = this.getSocket.bind(this)
    this.emitPageData = this.emitPageData.bind(this)
    this.emitStaticQueryData = this.emitStaticQueryData.bind(this)
  }

  init({ server, directory }) {
    this.programDir = directory

    const cachedStaticQueryResults = getCachedStaticQueryResults(
      this.staticQueryResults,
      this.programDir
    )
    this.staticQueryResults = new Map([
      ...this.staticQueryResults,
      ...cachedStaticQueryResults,
    ])

    this.websocket = require(`socket.io`)(server)

    this.websocket.on(`connection`, s => {
      let activePath = null

      // Send already existing static query results
      this.staticQueryResults.forEach(result => {
        this.websocket.send({
          type: `staticQueryResult`,
          payload: result,
        })
      })
      this.pageResults.forEach(result => {
        this.websocket.send({
          type: `pageQueryResult`,
          payload: result,
        })
      })

      const leaveRoom = path => {
        s.leave(getRoomNameFromPath(path))
        const leftRoom = this.websocket.sockets.adapter.rooms[
          getRoomNameFromPath(path)
        ]
        if (!leftRoom || leftRoom.length === 0) {
          this.activePaths.delete(path)
        }
      }

      s.on(`registerPath`, path => {
        s.join(getRoomNameFromPath(path))
        activePath = path
        this.activePaths.add(path)

        if (!this.pageResults.has(path)) {
          const result = getCachedPageData(path, this.programDir)
          this.pageResults.set(path, result)
        }

        this.websocket.send({
          type: `pageQueryResult`,
          payload: this.pageResults.get(path),
        })
      })

      s.on(`disconnect`, s => {
        leaveRoom(activePath)
      })

      s.on(`unregisterPath`, path => {
        leaveRoom(path)
      })
    })

    this.isInitialised = true
  }

  getSocket() {
    return this.isInitialised && this.websocket
  }

  emitStaticQueryData(data: QueryResult) {
    this.staticQueryResults.set(data.id, data)
    if (this.isInitialised) {
      this.websocket.send({ type: `staticQueryResult`, payload: data })
    }
  }
  emitPageData(data: QueryResult) {
    if (this.isInitialised) {
      this.websocket.send({ type: `pageQueryResult`, payload: data })
    }
    this.pageResults.set(data.id, data)
  }
}

const manager = new WebsocketManager()

module.exports = manager