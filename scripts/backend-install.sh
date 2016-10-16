#!/bin/bash
set -ev
cd backend
gcloud -q components update app-engine-python
pip install nosegae
pip install nose-exclude
pip install coveralls
pip install -t lib google-endpoints
pip install -r requirements.txt -t lib/
gem install coveralls-lcov

cd ../web-client
npm install


