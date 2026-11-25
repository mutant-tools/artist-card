#!/bin/sh
# Build and push dist/ to the gh-pages branch (GitHub Pages serves it).
# The Avantt fonts are not in the source repo but are part of the build.
set -e
cd "$(dirname "$0")"
npm run build
touch dist/.nojekyll
# the Figma plugin as a download, always the current one
rm -f dist/artist-card-figma-plugin.zip
zip -q -r -X dist/artist-card-figma-plugin.zip figma-plugin -x "*.DS_Store"
cd dist
rm -rf .git
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name=mutant-tools -c user.email=office@mutant.be commit -q -m "Deploy"
git push -f https://github.com/mutant-tools/artist-card.git gh-pages:gh-pages
rm -rf .git
echo "deployed"
