---
"@statewalker/webrun-modules": minor
"@statewalker/webrun-modules-build": minor
---

A missing module file fails instead of becoming an empty module (#9). A package whose manifest (`exports`, `browser`, `module` or `main`) names a file it does not ship is rejected at resolution, with the package, the subpath and the declared target in the error. New option `onMissingFile(id)` on `newModuleServer` and `newProjectBuild`: a returned string is used as the missing file's source; `undefined`, or no option, keeps the failure. Builds that emitted empty modules for missing files now fail.
