# Benchmark — N=1000 docs + 1000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2001 | 3 | 2000 | 2001 | 25003 | 921.4 | 164.9 |
| A cursors | 9001 | 36987 | 9 | 12000 | 11001 | 52974 | 2254.4 | 945.4 |
| B queue | 9001 | 75968 | 28148 | 10007 | 11002 | 46964 | 2023.8 | 1023.5 |
| C traces | 9001 | 16003 | 19 | 18000 | 11002 | 50004 | 2159.4 | 862.2 |

## no-op rebuild

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 0 | 1 | 0 | 0 | 0 | 0 | 0.0 | 0.1 |
| A cursors | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |
| B queue | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.2 |
| C traces | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |

## edit 1 doc (1 word)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9009 | 417.2 | 166.5 |
| A cursors | 5 | 18 | 6 | 1005 | 6 | 34 | 1.0 | 3.4 |
| B queue | 5 | 41 | 19 | 1009 | 6 | 16 | 0.5 | 1.8 |
| C traces | 5 | 6005 | 12 | 8000 | 7 | 18 | 0.9 | 32.7 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 2 | 3 | 23002 | 2 | 9006 | 417.1 | 135.1 |
| A cursors | 3 | 13 | 3 | 3 | 4 | 18 | 0.6 | 0.7 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 0.4 |
| C traces | 3 | 5004 | 8 | 6000 | 5 | 10 | 0.5 | 26.1 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 9001 | 11 | 3 | 23002 | 11 | 9123 | 419.8 | 123.4 |
| A cursors | 71 | 252 | 6 | 1080 | 81 | 490 | 14.9 | 22.3 |
| B queue | 71 | 566 | 229 | 1075 | 81 | 262 | 8.5 | 13.3 |
| C traces | 71 | 6062 | 12 | 8000 | 82 | 264 | 13.7 | 27.8 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 23001 | 2 | 9015 | 416.7 | 131.5 |
| A cursors | 8 | 27 | 6 | 1008 | 9 | 58 | 1.1 | 4.9 |
| B queue | 8 | 45 | 31 | 1011 | 9 | 35 | 0.5 | 2.8 |
| C traces | 8 | 5998 | 12 | 8012 | 10 | 42 | 0.5 | 29.2 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9003 | 417.3 | 114.5 |
| A cursors | 6 | 34 | 8 | 10 | 7 | 36 | 1.8 | 1.9 |
| B queue | 6 | 59 | 17 | 12 | 7 | 22 | 1.2 | 1.0 |
| C traces | 6 | 2005 | 6 | 2000 | 8 | 21 | 1.6 | 12.1 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 8994 | 2 | 3 | 22984 | 2 | 9164 | 432.4 | 66.2 |
| A cursors | 167 | 942 | 62 | 228 | 168 | 841 | 47.0 | 38.6 |
| B queue | 167 | 1611 | 340 | 337 | 168 | 562 | 30.7 | 26.4 |
| C traces | 167 | 2112 | 6 | 2000 | 169 | 504 | 44.8 | 11.9 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 22984 | 905.1 |
| A cursors | 41967 | 2132.8 |
| B queue | 27944 | 1492.6 |
| C traces | 22994 | 1743.3 |
