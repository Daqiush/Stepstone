#!/usr/bin/env bash

set -euo pipefail

project_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
project_root="$(cd "$project_root" && pwd)"
output_dir="${2:-${project_root}/bin}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
source_root="${project_root}/dds/library/src"
temporary_root="${TMPDIR:-/tmp}"
build_dir="$(mktemp -d "${temporary_root%/}/stepstone-dds-build.XXXXXX")"

cleanup() {
  case "$build_dir" in
    "${temporary_root%/}"/stepstone-dds-build.*) rm -rf -- "$build_dir" ;;
    *) printf 'Refusing to remove unexpected build directory: %s\n' "$build_dir" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ ! -d "$source_root" ]]; then
  printf 'DDS source directory is missing: %s\n' "$source_root" >&2
  exit 1
fi

mapfile -d '' sources < <(find "$source_root" -type f -name '*.cpp' -print0 | sort -z)
if [[ ${#sources[@]} -eq 0 ]]; then
  printf 'No DDS C++ sources found under: %s\n' "$source_root" >&2
  exit 1
fi

pushd "$build_dir" >/dev/null
g++ -std=c++20 -O3 -mtune=generic -fPIC -pthread \
  -I "$source_root" \
  -c "${sources[@]}"
ar rcs libdds.a ./*.o
g++ -std=c++20 -O3 -pthread -I "$source_root" \
  "$project_root/native/dds-cli/dds_calc.cpp" libdds.a \
  -o "$output_dir/dds_calc"
g++ -std=c++20 -O3 -pthread -I "$source_root" \
  "$project_root/native/dds-cli/dds_solve.cpp" libdds.a \
  -o "$output_dir/dds_solve"
popd >/dev/null

strip "$output_dir/dds_calc" "$output_dir/dds_solve"
printf 'DDS Linux binaries are ready in %s\n' "$output_dir"
