---
"@hot-updater/plugin-core": patch
---

Insights unique counts (DAU, WAU, MAU, active users, unique users) follow HyperLogLog's standard small-range rule: linear counting only while the raw estimate is at most 2.5 times the 1,024 registers and a register is still empty. Linear counting was used whenever any register was empty, which swung the estimate by 5–10% (up to 29%) between about 4,000 and 10,000 installations; it now stays near the 3% standard error. Only reading changes, so stored sketches stay valid.
