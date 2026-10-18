---
'@leaven-graphql/core': patch
---

Report a missing or unknown operation name as a client error. These used to surface as
`INTERNAL_ERROR` (with the compiler on) or with no code at all, so HTTP answered 500 and a
masking transport hid them as "An unexpected error occurred". The executor now rejects them
after validation with a `BAD_REQUEST` (400) error on every path (`execute`, `subscribe`, with
or without the compiler), and `parseRequest` and `CompiledQuery` throw the same `LeavenError`.

**Wording change:** the messages now match graphql-js: `Unknown operation named "x".`,
`Must provide operation name if query contains multiple operations.` and, for a document with
no operation, `Must provide an operation.` They replace `Operation "x" not found in document`,
`Operation "x" not found` and `No operation found in document`; code matching the old text must
match the new text or, better, `extensions.code`. The client-chosen name is still escaped.
