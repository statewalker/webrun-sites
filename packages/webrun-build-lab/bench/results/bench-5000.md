# Benchmark — N=5000 docs + 5000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 10001 | 3 | 10000 | 10001 | 125003 | 4648.6 | 613.8 |
| A cursors | 45001 | 184825 | 9 | 60000 | 55001 | 264812 | 11365.7 | 1314.9 |
| B queue | 45001 | 379806 | 140713 | 50007 | 55002 | 234802 | 10203.6 | 1327.3 |
| C traces | 45001 | 80003 | 19 | 90000 | 55002 | 250004 | 10877.1 | 950.3 |
| R webrun-builder | 45001 | 439807 | 110712 | 50007 | 10710 | 229881 | 9968.1 | 1410.6 |

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
| P0 naive | 45001 | 2 | 3 | 115002 | 2 | 45009 | 2085.1 | 664.1 |
| A cursors | 5 | 18 | 6 | 5005 | 6 | 34 | 1.0 | 9.1 |
| B queue | 5 | 41 | 19 | 5009 | 6 | 16 | 0.5 | 7.1 |
| C traces | 5 | 30005 | 12 | 40000 | 7 | 18 | 0.9 | 178.2 |
| R webrun-builder | 5 | 49 | 16 | 5009 | 6 | 16 | 0.5 | 11.1 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 2 | 3 | 115002 | 2 | 45006 | 2085.1 | 633.0 |
| A cursors | 3 | 13 | 3 | 3 | 4 | 18 | 0.6 | 0.2 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 0.1 |
| C traces | 3 | 25004 | 8 | 30000 | 5 | 10 | 0.5 | 147.9 |
| R webrun-builder | 3 | 35 | 9 | 5 | 4 | 9 | 0.3 | 0.3 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 51 | 3 | 115002 | 51 | 45603 | 2098.7 | 536.6 |
| A cursors | 351 | 1252 | 6 | 5400 | 401 | 2410 | 73.8 | 22.1 |
| B queue | 351 | 2806 | 1112 | 5355 | 401 | 1302 | 42.1 | 14.0 |
| C traces | 351 | 30302 | 12 | 40000 | 402 | 1304 | 67.8 | 174.4 |
| R webrun-builder | 351 | 3307 | 861 | 5355 | 58 | 1253 | 39.7 | 21.7 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 115001 | 2 | 45015 | 2084.7 | 561.5 |
| A cursors | 8 | 27 | 6 | 5008 | 9 | 58 | 1.1 | 11.9 |
| B queue | 8 | 45 | 31 | 5011 | 9 | 35 | 0.5 | 5.7 |
| C traces | 8 | 29998 | 12 | 40012 | 10 | 42 | 0.5 | 215.8 |
| R webrun-builder | 8 | 46 | 25 | 5011 | 6 | 35 | 0.5 | 8.8 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 114984 | 2 | 45014 | 2086.4 | 526.1 |
| A cursors | 17 | 97 | 11 | 24 | 18 | 91 | 5.0 | 0.8 |
| B queue | 17 | 166 | 39 | 34 | 18 | 58 | 3.2 | 0.7 |
| C traces | 17 | 10013 | 6 | 10000 | 19 | 54 | 4.7 | 68.9 |
| R webrun-builder | 17 | 183 | 28 | 34 | 3 | 53 | 3.0 | 1.0 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 114984 | 2 | 45136 | 2098.3 | 433.8 |
| A cursors | 139 | 787 | 51 | 186 | 140 | 701 | 39.7 | 4.4 |
| B queue | 139 | 1344 | 284 | 278 | 140 | 464 | 25.9 | 5.4 |
| C traces | 139 | 10095 | 6 | 10000 | 141 | 420 | 37.9 | 80.5 |
| R webrun-builder | 139 | 1483 | 191 | 278 | 4 | 419 | 23.4 | 6.0 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 114984 | 4570.2 |
| A cursors | 209805 | 10731.7 |
| B queue | 139782 | 7508.8 |
| C traces | 114994 | 8801.2 |
| R webrun-builder | 139782 | 7508.8 |
