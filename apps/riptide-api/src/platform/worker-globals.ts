/**
 * Side-effect module imported first by the Worker entry: ES module imports are hoisted, so global
 * patches must live in a module evaluated before the app graph rather than in `worker.ts` itself.
 * Keep it a bare side-effect import there (`import './platform/worker-globals'`): import sorting
 * leaves those in place, whereas a named import would be reordered after `./app`.
 */
import { disableStackTracesDuringStartup } from './startup-stack-traces'
import { installStreamsFetchSeam } from './streams-fetch'

installStreamsFetchSeam()
disableStackTracesDuringStartup()
