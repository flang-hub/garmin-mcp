#!/bin/zsh
# Fragt den Garmin-Personal-API-Schlüssel verdeckt ab, prüft ihn bei Garmin
# und speichert ihn nur bei Erfolg als Wrangler-Secret GARMIN_API_KEY.
set -u
cd "$(dirname "$0")/.."

read -rs "KEY?Garmin-Schluessel einfuegen und Enter: "
echo
# Leerzeichen und Zeilenumbrüche vom Kopieren entfernen.
KEY="${KEY//[[:space:]]/}"
if [[ -z "$KEY" ]]; then
	echo "Kein Schluessel eingegeben."
	exit 1
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
	https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token \
	-H "Authorization: ApiKey $KEY")
echo "Garmin antwortet: $CODE"
if [[ "$CODE" != "200" ]]; then
	echo "Schluessel wurde NICHT gespeichert. Bitte in Garmin Connect einen neuen erstellen und erneut versuchen."
	unset KEY
	exit 1
fi

printf '%s' "$KEY" | npx wrangler secret put GARMIN_API_KEY
unset KEY
echo "GARMIN-SCHLUESSEL GESPEICHERT"
