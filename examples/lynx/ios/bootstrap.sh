#!/bin/sh
set -eu
cd "$(dirname "$0")"
revision=c4ce8d25c5ea277e13752d68ff1f2a66f5704240
if [ ! -d .upstream/sparkling/.git ]; then
  mkdir -p .upstream
  git clone https://github.com/tiktok/sparkling.git .upstream/sparkling
fi
git -C .upstream/sparkling checkout --detach "$revision"
pod install
