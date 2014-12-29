var gulp = require('gulp');
var react = require('gulp-react');
var sass = require('gulp-sass');
var js_source = 'trackdidia/static/js/app/src';
var js_dest = 'trackdidia/static/js/app/build';
var css_source = 'trackdidia/static/css/src';
var css_dest = 'trackdidia/static/css/build';
var spawn = require('child_process').spawn;

gulp.task('watch', function() {
	jsx_e = spawn('jsx', ['-w', 'trackdidia/static/js/app/src', 'trackdidia/static/js/app/build']);
	sass_e = spawn('sass', ['--watch', 'trackdidia/static/css/src:trackdidia/static/css/build']);

	jsx_e.stdout.on('data', function(data) {
		console.log(data.toString());
	});
	jsx_e.stderr.on('data', function(data){
		console.log(data.toString())
	});
	jsx_e.on('close', function(code){
		console.log('JSX exited with code ' + code);
	});

	sass_e.stdout.on('data', function(data) {
		console.log(data.toString());
	});
	sass_e.stderr.on('data', function(data){
		console.log(data.toString());
	});
	sass_e.on('close', function(code){
		console.log('SASS exited with code ' + code);
	});
});