# Benchmark — N=1000 docs + 1000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2001 | 3 | 2000 | 2001 | 25003 | 921.4 | 153.2 |
| A cursors | 9001 | 36987 | 9 | 12000 | 11001 | 52974 | 2254.4 | 271.1 |
| B queue | 9001 | 75968 | 28148 | 10007 | 11002 | 46964 | 2023.8 | 286.5 |
| C traces | 9001 | 16003 | 19 | 18000 | 11002 | 50004 | 2159.4 | 222.4 |
| R webrun-builder | 9001 | 87969 | 22147 | 10007 | 2145 | 45980 | 1977.7 | 315.7 |

## no-op rebuild

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 0 | 1 | 0 | 0 | 0 | 0 | 0.0 | 0.1 |
| A cursors | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |
| B queue | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.2 |
| C traces | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |
| R webrun-builder | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.1 |

## edit 1 doc (1 word)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9009 | 417.2 | 171.6 |
| A cursors | 5 | 18 | 6 | 1005 | 6 | 34 | 1.0 | 2.5 |
| B queue | 5 | 41 | 19 | 1009 | 6 | 16 | 0.5 | 1.6 |
| C traces | 5 | 6005 | 12 | 8000 | 7 | 18 | 0.9 | 53.1 |
| R webrun-builder | 5 | 49 | 16 | 1009 | 6 | 16 | 0.5 | 2.4 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9006 | 417.1 | 160.7 |
| A cursors | 3 | 13 | 3 | 3 | 4 | 18 | 0.6 | 0.3 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 0.1 |
| C traces | 3 | 5004 | 8 | 6000 | 5 | 10 | 0.5 | 42.6 |
| R webrun-builder | 3 | 35 | 9 | 5 | 4 | 9 | 0.3 | 0.3 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 11 | 3 | 23002 | 11 | 9123 | 419.8 | 129.3 |
| A cursors | 71 | 252 | 6 | 1080 | 81 | 490 | 14.9 | 4.4 |
| B queue | 71 | 566 | 229 | 1075 | 81 | 262 | 8.5 | 2.4 |
| C traces | 71 | 6062 | 12 | 8000 | 82 | 264 | 13.7 | 46.7 |
| R webrun-builder | 71 | 667 | 178 | 1075 | 15 | 253 | 8.0 | 4.2 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 23001 | 2 | 9015 | 416.7 | 131.7 |
| A cursors | 8 | 27 | 6 | 1008 | 9 | 58 | 1.1 | 2.9 |
| B queue | 8 | 45 | 31 | 1011 | 9 | 35 | 0.5 | 1.5 |
| C traces | 8 | 5998 | 12 | 8012 | 10 | 42 | 0.5 | 46.7 |
| R webrun-builder | 8 | 46 | 25 | 1011 | 6 | 35 | 0.5 | 2.7 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9003 | 417.3 | 139.6 |
| A cursors | 6 | 34 | 8 | 10 | 7 | 36 | 1.8 | 0.6 |
| B queue | 6 | 59 | 17 | 12 | 7 | 22 | 1.2 | 0.3 |
| C traces | 6 | 2005 | 6 | 2000 | 8 | 21 | 1.6 | 18.2 |
| R webrun-builder | 6 | 65 | 14 | 12 | 3 | 20 | 1.0 | 0.5 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9164 | 432.4 | 111.3 |
| A cursors | 167 | 942 | 62 | 228 | 168 | 841 | 47.0 | 6.8 |
| B queue | 167 | 1611 | 340 | 337 | 168 | 562 | 30.7 | 5.3 |
| C traces | 167 | 2112 | 6 | 2000 | 169 | 504 | 44.8 | 19.3 |
| R webrun-builder | 167 | 1778 | 230 | 337 | 4 | 503 | 27.5 | 6.9 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 22984 | 905.1 |
| A cursors | 41967 | 2132.8 |
| B queue | 27944 | 1492.6 |
| C traces | 22994 | 1743.3 |
| R webrun-builder | 27944 | 1492.6 |
