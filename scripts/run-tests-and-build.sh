#!/bin/bash
set -ev
cd backend
nosetests -v --with-gae --with-coverage --cover-package=trackdidia --cover-min-percentage=90
cd ../web-client
npm run test
npm run build
cp -r build/* ../backend/