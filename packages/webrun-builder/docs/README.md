# webrun-builder documentation

- [How the build engine works](how-it-works.md): collections and builders, the store layout, how a
  change propagates, early cut-off, retraction and `dispose`, builder kinds, failures and dead
  letters, running in steps, persistence, `ProjectBuilder`. With diagrams.
- [Use case: re-indexing a document folder](use-case-reindexing.md): extract text, chunk, full-text
  and vector indexes, screenshots; change detection with `scanSources`, incremental rebuilds with
  `steps()`, what each kind of change re-runs, forcing rebuilds with `invalidate` / `version`.

The API reference is the package [README](../README.md).
