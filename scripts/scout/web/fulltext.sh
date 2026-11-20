#!/usr/bin/env bash
# Full text of an item as a plain-text file, for close discussion.
# Usage: scripts/scout/web/fulltext.sh <item> [output-dir]
# An item is an arXiv id (2507.11473, arxiv:2507.11473v2, hep-th/9901001), an arXiv abstract or PDF URL, any other
# http(s) URL, or "url:<url>" or "doi:<doi>" as site/digests.js writes ids. Only http and https addresses are fetched,
# also after a redirect, and a path to a local file is not an item.
# The first form writes <output-dir>/<name>.txt and prints its path; a PDF is kept beside it as <name>.pdf, so figures
# and equations can be read as images. Claude passes its session scratchpad as output-dir, which it can read without a
# permission prompt. Without it: $LIMINAL_TMP, else $TMPDIR/liminal-fulltext. The output folder must be a temporary
# folder (scripts/scout/web/fetch-guard.ts), so nothing lands in the repo.
# Only addresses on the public internet are fetched, also at each redirect. Tests name their local stand-ins in
# $LIMINAL_ALLOW_LOCAL.
# arXiv PDFs come from $ARXIV_PDF_BASE and DOIs from $DOI_BASE; tests point both at local stand-ins.
# Needs curl, node and pdftotext (poppler); for web pages, textutil on macOS and w3m on Linux (the cloud scout's
# GitHub runner, where scout.yml installs it with apt).
set -euo pipefail

SCRIPTS=$(dirname -- "$0")
LIB="$SCRIPTS/../../lib"
# Shared values, from scripts/lib/constants.json: export.arxiv.org is the host arXiv sets aside for programmatic access
# (https://info.arxiv.org/help/bulk_data.html); the user agent is Chrome's, so requests look like any visitor's.
# One node start reads all five.
# Not node -p: it colours numbers.
constants=$(node -e '
  const constants = require(require("node:path").resolve(process.argv[1]));
  const names = ["arxivPdf", "doiBase", "userAgent", "curlTimeoutSeconds", "converterTimeoutSeconds"];
  process.stdout.write(names.map((name) => String(constants[name])).join("\n"));
' -- "$LIB/constants.json")
{
  IFS= read -r arxiv_pdf_default
  IFS= read -r doi_base_default
  IFS= read -r USER_AGENT
  IFS= read -r CURL_TIMEOUT_SECONDS
  IFS= read -r converter_timeout_default
} <<< "$constants"
ARXIV_PDF_BASE=${ARXIV_PDF_BASE:-$arxiv_pdf_default}
DOI_BASE=${DOI_BASE:-$doi_base_default}
# Converter time limit.
CONVERTER_TIMEOUT_SECONDS=${CONVERTER_TIMEOUT_SECONDS:-$converter_timeout_default}
# Exit status after SIGALRM.
TIMED_OUT=142
MAX_REDIRECTS=5
# The most a download may hold, 100 MB: curl refuses a larger declared length before it reads the body, and stops a
# body that grows past it. Without it a fast server could fill the runner's disk inside the time limit.
MAX_DOWNLOAD_BYTES=$((100 * 1024 * 1024))
# curl's exit code for a download over --max-filesize (CURLE_FILESIZE_EXCEEDED).
CURL_TOO_LARGE=63
# A page shorter than this that holds a bot-check phrase is a challenge page, not the article.
CHALLENGE_MAX_CHARACTERS=3000

# arXiv ids: new style 2507.11473 (4 or 5 digits after the dot), old style hep-th/9901001 or math.AG/0101001,
# either with an optional version such as v2. An archive name starts with a letter, so no id starts with "-".
ARXIV_ID_PATTERN='^([0-9]{4}\.[0-9]{4,5}|[a-z][a-z-]*(\.[A-Z]{2})?/[0-9]{7})(v[0-9]+)?$'
# arXiv abstract and PDF pages, http or https, with or without www.; group 3 is what follows /abs/ or /pdf/.
ARXIV_URL_PATTERN='^https?://(www\.)?arxiv\.org/(abs|pdf)/(.+)$'

# Set by fetch(): the answer's Content-Type, and why a fetch failed.
content_type=''
fetch_error=''

# The file being downloaded, deleted when the script exits however it exits (Python: a finally clause).
download=''
remove_download() {
  if [[ -n $download ]]; then
    rm -f -- "$download"
  fi
}
trap remove_download EXIT

# Print an error naming the script and stop, as arxiv.ts's fail() does.
fail() {
  echo "fulltext.sh: $1" >&2
  exit 1
}

# Time limit; macOS lacks timeout.
run_limited() {
  perl -e 'alarm shift; exec @ARGV or die "$!\n"' -- "$CONVERTER_TIMEOUT_SECONDS" "$@"
}

# Print the arXiv id in an argument such as "2507.11473v2" or "arXiv:hep-th/9901001"; return 1 when it holds none.
arxiv_id_of() {
  local id=$1
  # Drop an "arxiv:" prefix in any letter case.
  case $id in
    [Aa][Rr][Xx][Ii][Vv]:*) id=${id#*:} ;;
  esac
  if [[ $id =~ $ARXIV_ID_PATTERN ]]; then
    echo "$id"
  else
    return 1
  fi
}

# Print the arXiv id in an arXiv abstract or PDF URL, version kept and ".pdf" dropped; return 1 for any other URL.
arxiv_id_of_url() {
  local path
  if [[ ! $1 =~ $ARXIV_URL_PATTERN ]]; then
    return 1
  fi
  path=${BASH_REMATCH[3]}
  # Drop a #fragment, then a ?query (abs/2507.11473?context=cs, pdf/2507.11473v2#page=3): neither is part of the id.
  # The ? is escaped because in a ${...%%pattern} it matches any one character (unescaped, ?* would drop the whole
  # path); # is a plain character there.
  path=${path%%#*}
  path=${path%%\?*}
  path=${path%.pdf}
  if [[ $path =~ $ARXIV_ID_PATTERN ]]; then
    echo "$path"
  else
    return 1
  fi
}

# Download <url> into <file>, following up to 5 redirects itself so each address is checked before it is asked.
# Sets content_type; on failure sets fetch_error and returns 1.
fetch() {
  local url=$1
  local file=$2
  local hop=0
  local pin
  local report
  local http_code
  local location
  local status
  while true; do
    # The address must be on the public internet; curl then connects only to the address the guard checked
    # (--connect-to), whatever host it reads from the URL. The guard prints nothing for the one allowed test stand-in.
    if ! pin=$(node "$SCRIPTS/fetch-guard.ts" url "$url" 2>&1); then
      fetch_error=$pin
      if (( hop > 0 )); then
        fetch_error="redirect to $url: $pin"
      fi
      return 1
    fi
    # The body goes to <file>; -w then prints four lines: status code, content type, redirect target, curl's error.
    # --proto allows only http and https; "--" ends curl's options, so a URL starting with "-" can't be read as one.
    local options=(-s -m "$CURL_TIMEOUT_SECONDS" --max-filesize "$MAX_DOWNLOAD_BYTES" --proto "=http,https" -A "$USER_AGENT" -o "$file")
    if [[ -n $pin ]]; then
      options+=(--connect-to "$pin")
    fi
    status=0
    report=$(curl "${options[@]}" -w '%{http_code}\n%{content_type}\n%{redirect_url}\n%{errormsg}' -- "$url") \
      || status=$?
    http_code=$(sed -n 1p <<< "$report")
    content_type=$(sed -n 2p <<< "$report")
    location=$(sed -n 3p <<< "$report")
    if (( status == CURL_TOO_LARGE )); then
      fetch_error="larger than $((MAX_DOWNLOAD_BYTES / 1024 / 1024)) MB"
      return 1
    fi
    if (( status != 0 )); then
      fetch_error=$(sed -n 4p <<< "$report")
      if [[ -z $fetch_error ]]; then
        fetch_error="curl exit code $status"
      fi
      return 1
    fi
    if (( http_code < 300 || http_code >= 400 )) || [[ -z $location ]]; then
      break
    fi
    # A redirect: only to http or https, and at most 5 of them.
    if [[ $location != http://* && $location != https://* ]]; then
      fetch_error="redirect to $location, which is not an http or https address"
      return 1
    fi
    hop=$((hop + 1))
    if (( hop > MAX_REDIRECTS )); then
      fetch_error="too many redirects (more than $MAX_REDIRECTS)"
      return 1
    fi
    url=$location
  done
  # Without --fail, curl succeeds on an error status, so check it here.
  if (( http_code >= 400 )); then
    fetch_error="HTTP $http_code"
    return 1
  fi
}

# True when <file> starts with the PDF signature "%PDF-".
is_pdf() {
  [[ $(head -c 5 -- "$1") == '%PDF-' ]]
}

# Print the character set to decode an HTML page with: the Content-Type header's, else the page's
# <meta charset> or http-equiv declaration, else UTF-8. textutil and w3m take the IANA name as given.
charset_of() {
  local header=$1
  local page=$2
  local header_pattern='charset="?([a-z0-9._:-]+)'
  local meta_pattern="<meta[^>]*charset=[\"']?([a-z0-9._:-]+)"
  local lower_header
  local lower_page
  # Work on bytes: a windows-1252 page isn't valid UTF-8, so under a UTF-8 locale tr refuses it and =~ matches
  # nothing. The local LC_ALL covers bash's own =~ until the function returns; the prefix covers each tr.
  local LC_ALL=C
  # Tags and charset names ignore case, so match on lower case.
  lower_header=$(printf '%s' "$header" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  if [[ $lower_header =~ $header_pattern ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  lower_page=$(LC_ALL=C tr '[:upper:]' '[:lower:]' < "$page")
  if [[ $lower_page =~ $meta_pattern ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  echo 'UTF-8'
}

# True when a converted page is short and holds a bot-check phrase ("Just a moment...", "Enable JavaScript and
# cookies"), so the site answered with a challenge instead of the article.
is_challenge_page() {
  local text_file=$1
  local characters
  # Count characters, not bytes, whatever the caller's locale; html_to_text writes UTF-8.
  characters=$(LC_ALL=en_US.UTF-8 wc -m < "$text_file")
  if (( characters >= CHALLENGE_MAX_CHARACTERS )); then
    return 1
  fi
  grep -q -i -F \
    -e 'enable javascript and cookies' \
    -e 'just a moment...' \
    -e 'checking your browser' \
    -e 'attention required!' \
    -e 'please enable cookies' \
    -e 'verify you are human' \
    -- "$text_file"
}

# Turn the HTML page <page>, in character set <charset>, into plain UTF-8 text in <txt>, each heading and paragraph on
# its own line, without script or style text.
html_to_text() {
  local page=$1
  local charset=$2
  local txt=$3
  if [[ $(uname -s) == Darwin ]]; then
    # textutil is told the character set; -noload fetches nothing the page names.
    textutil -noload -format html -inputencoding "$charset" -convert txt -output "$txt" "$page" >/dev/null
  else
    # w3m on Linux: the page comes on standard input, so its path is never read as an address.
    local status=0
    run_limited w3m -dump -T text/html -I "$charset" -O UTF-8 -cols 1024 < "$page" > "$txt" || status=$?
    if (( status == TIMED_OUT )); then
      rm -f -- "$txt"
      fail "w3m ran more than $CONVERTER_TIMEOUT_SECONDS seconds on the page"
    elif (( status != 0 )); then
      fail "w3m could not read the page"
    fi
  fi
}

# Write the full text of one item into <output-dir> and print the text file's path.
full_text() {
  local item=$1
  local out_dir=$2
  local url=''
  local arxiv_id=''
  local name
  local txt
  local pdf
  local charset

  # The address to fetch, checked in this order: url:, doi:, an arXiv URL, another URL, an arXiv id.
  if [[ $item == url:* ]]; then
    url=${item#url:}
  elif [[ $item == doi:* ]]; then
    url="$DOI_BASE/${item#doi:}"
  elif arxiv_id=$(arxiv_id_of_url "$item"); then
    url="$ARXIV_PDF_BASE/$arxiv_id"
  elif [[ $item == http://* || $item == https://* ]]; then
    url=$item
  elif arxiv_id=$(arxiv_id_of "$item"); then
    url="$ARXIV_PDF_BASE/$arxiv_id"
  fi
  # Only an http or https address goes on. This stops an item no rule above names (a path such as /etc/hosts, or
  # anything starting with "-"), and a url: or doi: that comes out as another scheme (url:file:///etc/hosts).
  if [[ $url != http://* && $url != https://* ]]; then
    fail "\"$item\" is not an arXiv id, URL, doi: or url:"
  fi

  # The output folder must be a temporary folder; the guard gives its real path, so a link can't lead elsewhere.
  if ! out_dir=$(node "$SCRIPTS/fetch-guard.ts" folder "$out_dir" 2>&1); then
    fail "$out_dir"
  fi
  # "--" ends the options, so a folder name starting with "-" is a folder, not a flag; the same "--" guards mkdir, head,
  # grep, mv and rm below. pdftotext and textutil read a path starting with "-" as a file already.
  mkdir -p -- "$out_dir"
  name=$(printf '%s' "$item" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)
  txt="$out_dir/$name.txt"
  pdf="$out_dir/$name.pdf"

  # Fetch into a download beside the text.
  download="$out_dir/$name.download"
  if ! fetch "$url" "$download"; then
    fail "could not fetch $url: $fetch_error"
  fi

  # arXiv serves every paper as a PDF; anything else from it (a page, an error text) is not the paper.
  if [[ -n $arxiv_id ]]; then
    if ! is_pdf "$download"; then
      fail "arXiv gave something that isn't a PDF for $arxiv_id: $url"
    fi
  fi

  if is_pdf "$download" || [[ $content_type == application/pdf* ]]; then
    # Plain pdftotext keeps reading order, so a two-column page reads column by column (-layout interleaves them).
    local status=0
    run_limited pdftotext "$download" "$txt" || status=$?
    if (( status == TIMED_OUT )); then
      rm -f -- "$txt"
      fail "pdftotext ran more than $CONVERTER_TIMEOUT_SECONDS seconds on the PDF for $item"
    elif (( status != 0 )); then
      fail "could not read the PDF for $item"
    fi
    # Keep the PDF beside its text, for figures and equations.
    mv -- "$download" "$pdf"
  else
    # A web page, decoded with its own character set.
    charset=$(charset_of "$content_type" "$download")
    html_to_text "$download" "$charset" "$txt"
    rm -f -- "$download"
    if is_challenge_page "$txt"; then
      rm -f -- "$txt"
      fail "$url answered with a page that asks for JavaScript or cookies, not the article"
    fi
  fi
  echo "$txt"
}

# Main: the full text of one item.
if (( $# == 0 )); then
  fail 'usage: scripts/scout/web/fulltext.sh <item> [output-dir]'
else
  full_text "$1" "${2:-${LIMINAL_TMP:-${TMPDIR:-/tmp}/liminal-fulltext}}"
fi
