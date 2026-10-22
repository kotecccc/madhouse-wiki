#!/bin/sh
set -eu
cd /opt/madhouse-storage
umask 077
slot=$(date +%u)
temporary="backups/data-${slot}.tgz.tmp"
tar -czf "$temporary" data
mv "$temporary" "backups/data-${slot}.tgz"
