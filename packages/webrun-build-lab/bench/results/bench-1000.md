# Benchmark — N=1000 docs + 1000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2001 | 3 | 2000 | 2001 | 25003 | 921.4 | 127.4 |
| B queue | 9001 | 75968 | 28148 | 10007 | 11002 | 46964 | 2023.8 | 866.1 |

## no-op rebuild

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 0 | 1 | 0 | 0 | 0 | 0 | 0.0 | 0.1 |
| B queue | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.2 |

## edit 1 doc (1 word)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9009 | 417.2 | 120.1 |
| B queue | 5 | 41 | 19 | 1009 | 6 | 16 | 0.5 | 2.0 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9006 | 417.1 | 137.0 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 0.4 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 11 | 3 | 23002 | 11 | 9123 | 419.8 | 133.1 |
| B queue | 71 | 566 | 229 | 1075 | 81 | 262 | 8.5 | 9.7 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 23001 | 2 | 9015 | 416.7 | 129.3 |
| B queue | 8 | 45 | 31 | 1011 | 9 | 35 | 0.5 | 2.9 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9003 | 417.3 | 85.2 |
| B queue | 6 | 59 | 17 | 12 | 7 | 22 | 1.2 | 1.0 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9164 | 432.4 | 89.6 |
| B queue | 167 | 1611 | 340 | 337 | 168 | 562 | 30.7 | 19.0 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 22984 | 905.1 |
| B queue | 27944 | 1492.6 |
