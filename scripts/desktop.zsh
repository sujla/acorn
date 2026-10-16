#!/bin/zsh
set -e

script_dir=${0:A:h}
project_dir=${script_dir:h}

exec "$project_dir/node_modules/.bin/electron" "$project_dir"
