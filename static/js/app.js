// Place third party dependencies in the lib folder
//
// Configure loading modules from the lib directory,
// except 'app' ones, 
requirejs.config({
    "baseUrl": "/static/js/lib",
    "paths": {
      "app": "../app/build",
      "components": "../app/components",
      "models": "../app/models"

    }
});

// Load the main app module to start the app
requirejs(["app/index"]);