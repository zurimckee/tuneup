# check_bucket.py
import os
from collections import Counter
from library import s3, R2_BUCKET

keys = []
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=R2_BUCKET):
    keys += [o["Key"] for o in page.get("Contents", [])]

print("total objects:", len(keys))
print(Counter(os.path.splitext(k)[1].lower() for k in keys))
print([k for k in keys if not k.lower().endswith(".webm")][:40])