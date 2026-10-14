#!/usr/bin/env node
/** A CLI stand-in that exits non-zero without emitting a result record. */

process.stderr.write('fake qoderclicn failure\n')
process.exit(3)
