# Benchmark — N=1000 docs + 1000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2001 | 3 | 2000 | 2001 | 25003 | 921.4 | 105.3 |
| A cursors | 9001 | 36987 | 9 | 12000 | 11001 | 52974 | 2254.4 | 277.8 |
| B queue | 9001 | 75968 | 28148 | 10007 | 11002 | 46964 | 2023.8 | 226.9 |
| C traces | 9001 | 16003 | 19 | 18000 | 11002 | 50004 | 2159.4 | 157.1 |
| R webrun-builder | 9001 | 69967 | 22147 | 10007 | 2145 | 45980 | 2438.5 | 362.3 |

## no-op rebuild

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 0 | 1 | 0 | 0 | 0 | 0 | 0.0 | 0.1 |
| A cursors | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.1 |
| B queue | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.1 |
| C traces | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |
| R webrun-builder | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.1 |

## edit 1 doc (1 word)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9009 | 417.2 | 124.6 |
| A cursors | 5 | 18 | 6 | 1005 | 6 | 34 | 1.0 | 1.6 |
| B queue | 5 | 41 | 19 | 1008 | 6 | 16 | 0.5 | 1.3 |
| C traces | 5 | 6005 | 12 | 8000 | 7 | 18 | 0.9 | 31.1 |
| R webrun-builder | 5 | 40 | 16 | 1008 | 6 | 20 | 0.9 | 2.6 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9006 | 417.1 | 144.9 |
| A cursors | 3 | 13 | 3 | 3 | 4 | 18 | 0.6 | 0.2 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 0.1 |
| C traces | 3 | 5004 | 8 | 6000 | 5 | 10 | 0.5 | 26.0 |
| R webrun-builder | 3 | 29 | 9 | 5 | 4 | 12 | 0.6 | 0.5 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 11 | 3 | 23002 | 11 | 9123 | 419.8 | 133.3 |
| A cursors | 71 | 252 | 6 | 1080 | 81 | 490 | 14.9 | 2.6 |
| B queue | 71 | 566 | 229 | 1074 | 81 | 262 | 8.5 | 2.5 |
| C traces | 71 | 6062 | 12 | 8000 | 82 | 264 | 13.7 | 41.1 |
| R webrun-builder | 71 | 526 | 178 | 1074 | 15 | 323 | 14.9 | 4.9 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 23001 | 2 | 9015 | 416.7 | 81.0 |
| A cursors | 8 | 27 | 6 | 1008 | 9 | 58 | 1.1 | 1.6 |
| B queue | 8 | 45 | 31 | 1010 | 9 | 35 | 0.5 | 1.5 |
| C traces | 8 | 5998 | 12 | 8012 | 10 | 42 | 0.5 | 45.8 |
| R webrun-builder | 8 | 38 | 25 | 1010 | 6 | 35 | 0.5 | 2.4 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9003 | 417.3 | 100.6 |
| A cursors | 6 | 34 | 8 | 10 | 7 | 36 | 1.8 | 0.4 |
| B queue | 6 | 59 | 17 | 12 | 7 | 22 | 1.2 | 0.5 |
| C traces | 6 | 2005 | 6 | 2000 | 8 | 21 | 1.6 | 16.9 |
| R webrun-builder | 6 | 53 | 14 | 12 | 3 | 26 | 2.6 | 0.7 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9164 | 432.4 | 101.9 |
| A cursors | 167 | 942 | 62 | 228 | 168 | 841 | 47.0 | 5.4 |
| B queue | 167 | 1611 | 340 | 337 | 168 | 562 | 30.7 | 4.5 |
| C traces | 167 | 2112 | 6 | 2000 | 169 | 504 | 44.8 | 19.5 |
| R webrun-builder | 167 | 1444 | 230 | 337 | 4 | 670 | 68.0 | 12.8 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 22984 | 905.1 |
| A cursors | 41967 | 2132.8 |
| B queue | 27944 | 1492.6 |
| C traces | 22994 | 1743.3 |
| R webrun-builder | 27944 | 1953.2 |
