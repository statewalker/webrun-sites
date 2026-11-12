# Benchmark — N=5000 docs + 5000 modules

## cold build

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 10001 | 3 | 10000 | 10001 | 125003 | 4648.6 | 1256.6 |
| A cursors | 45001 | 184825 | 9 | 60000 | 55001 | 264812 | 11365.7 | 15426.4 |
| B queue | 45001 | 379806 | 140713 | 50007 | 55002 | 234802 | 10203.6 | 17628.6 |
| C traces | 45001 | 80003 | 19 | 90000 | 55002 | 250004 | 10877.1 | 14433.0 |

## no-op rebuild

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 0 | 1 | 0 | 0 | 0 | 0 | 0.0 | 0.2 |
| A cursors | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |
| B queue | 0 | 1 | 1 | 0 | 0 | 0 | 0.0 | 0.1 |
| C traces | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 |

## edit 1 doc (1 word)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 2 | 3 | 115002 | 2 | 45009 | 2085.1 | 569.4 |
| A cursors | 5 | 18 | 6 | 5005 | 6 | 34 | 1.0 | 17.1 |
| B queue | 5 | 41 | 19 | 5009 | 6 | 16 | 0.5 | 8.6 |
| C traces | 5 | 30005 | 12 | 40000 | 7 | 18 | 0.9 | 242.9 |

## edit 1 doc (cut-off)

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 2 | 3 | 115002 | 2 | 45006 | 2085.1 | 421.3 |
| A cursors | 3 | 13 | 3 | 3 | 4 | 18 | 0.6 | 2.7 |
| B queue | 3 | 29 | 10 | 5 | 4 | 9 | 0.3 | 1.6 |
| C traces | 3 | 25004 | 8 | 30000 | 5 | 10 | 0.5 | 198.2 |

## edit 1% docs

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 45001 | 51 | 3 | 115002 | 51 | 45603 | 2098.7 | 488.1 |
| A cursors | 351 | 1252 | 6 | 5400 | 401 | 2410 | 73.8 | 459.7 |
| B queue | 351 | 2806 | 1112 | 5355 | 401 | 1302 | 42.1 | 158.3 |
| C traces | 351 | 30302 | 12 | 40000 | 402 | 1304 | 67.8 | 216.6 |

## delete 1 doc

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 115001 | 2 | 45015 | 2084.7 | 628.7 |
| A cursors | 8 | 27 | 6 | 5008 | 9 | 58 | 1.1 | 29.3 |
| B queue | 8 | 45 | 31 | 5011 | 9 | 35 | 0.5 | 9.9 |
| C traces | 8 | 29998 | 12 | 40012 | 10 | 42 | 0.5 | 161.0 |

## edit leaf module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 114984 | 2 | 45014 | 2086.4 | 701.0 |
| A cursors | 17 | 97 | 11 | 24 | 18 | 91 | 5.0 | 18.0 |
| B queue | 17 | 166 | 39 | 34 | 18 | 58 | 3.2 | 5.6 |
| C traces | 17 | 10013 | 6 | 10000 | 19 | 54 | 4.7 | 59.4 |

## edit hub module

| engine | exec | gets | scans | scanned | commits | written | KB written | ms |
|---|---|---|---|---|---|---|---|---|
| P0 naive | 44994 | 2 | 3 | 114984 | 2 | 45136 | 2098.3 | 542.3 |
| A cursors | 139 | 787 | 51 | 186 | 140 | 701 | 39.7 | 139.3 |
| B queue | 139 | 1344 | 284 | 278 | 140 | 464 | 25.9 | 42.6 |
| C traces | 139 | 10095 | 6 | 10000 | 141 | 420 | 37.9 | 71.6 |

## Stored state after all scenarios

| engine | rows | KB |
|---|---|---|
| P0 naive | 114984 | 4570.2 |
| A cursors | 209805 | 10731.7 |
| B queue | 139782 | 7508.8 |
| C traces | 114994 | 8801.2 |
