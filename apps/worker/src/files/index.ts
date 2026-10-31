/** Files in the worker (FILE-001): scan, delete and erase jobs, abandoned-upload housekeeping and tombstone replay. See README.md. */
export {
  registerFiles, filesExpireUploadsTask, requestFileErasure, replayFileTombstones,
  FILES_SCAN_KIND, FILES_DELETE_KIND, FILES_EXPIRE_TASK, FILES_SCAN_ATTEMPTS, FILES_DELETE_ATTEMPTS, FILES_METRICS,
  type FilesRuntime, type ErasureReport, type ReplayReport,
} from './handlers.js';
export { inspect, matchesMediaType, hasLocationMetadata, tiffHasGps, isPlainUtf8Text, sha256Hex, type InspectionFailure, type Declared } from './inspect.js';
export { FakeMalwareScanner, ScannerUnavailableError, scannerFromEnv, EICAR_TEST_STRING, type MalwareScanner, type ScanVerdict } from './scanner.js';
