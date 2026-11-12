export {
  type DocumentIndex,
  type DocumentIndexOptions,
  openDocumentIndex,
  type SearchHit,
  type UpdateReport,
} from "./document-index.js";
export { decodeEmbedding, encodeEmbedding, hashingEmbedder } from "./embedders.js";
export { FilesIndexerPersistence } from "./files-persistence.js";
