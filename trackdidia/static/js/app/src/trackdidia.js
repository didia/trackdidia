 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["jquery", "models/Week", "models/Task", "app/event", "app/constants"], function($, Week, Task, EventProvider, Constants){

 	var links = {}
 	var week= null;
 	var me = null;
 	var tasks = {};
 	var nonDeletedTasks = {};
 	var recurrenceTypes = ['weekly', 'daily']

 	function log(message) {
 		console.log(message);
 	}

 	function initSchedule() {
 		callRemote(links['week'], null, function(response, status){
 			if(status == "ok") {
 				var weekData = response;
 				week = new Week(weekData);
 				save("week", weekData);
 				EventProvider.fire(Constants.SCHEDULE_LOADED_EVENT);
 			}
 		});
 	}

 	function initTasks(){
 		callRemote(links['tasks'], null, function(response, status){
 			if(status == "ok") {
 				links = $.extend({}, links, response.links);
 				var tasksData = response.tasks;
 				populateTasks(tasksData);
 			}
 		});
 	}

 	function populateTasks(tasksData) {
		tasks = {};
		nonDeletedTasks = {};
		tasksData.forEach(function(task_data) {
			var task = new Task(task_data);
			if(!task.deleted)
			{
				nonDeletedTasks[task.id] = task;
			}
			tasks[task.id] = task;
		});

		save("tasks", tasksData);
 	}

 	function save(key, object) {
		window.localStorage.setItem(key, JSON.stringify(object));
	}

	function callRemote(endpoint, request, cb) {
		var method = null;
		if(request == null) {
			request = {};
		}
	
		if (typeof endpoint == 'string')
		{
			method = 'GET';
		}
		else {
			console.log(endpoint);
			method = endpoint.method;
			endpoint = endpoint.url;

			
		}
	    log("Calling endpoint: " + endpoint + " with method: " + method);	 
	    if(endpoint[0] != "/")
	    	endpoint = "/" + endpoint;
	    //endpoint = this._domain.api + endpoint;

		$.ajax({
		 	type: method,
		 	url:endpoint,
		 	dataType:"json", 
		 	async: true,
		 	data: request, 
			//contentType: "application/json; charset=utf-8",

		 	success:function(data){
				if (cb != null && typeof cb != undefined)
				    cb.apply(null, [data, "ok"])
			},

		 	error: function(jqxhr, textstatus, error){
		 		if (cb != null && typeof cb != undefined)
				    cb.apply(null, [jqxhr.responseText, "failed"]);


			}
	    });
	}

 	return {
 		initialize : function() {
 			callRemote("/api/enter", null, function(response, status) {
 				if(status == "ok") {
 					me = response.me;
 					links = response.links;
 					initSchedule();
 					initTasks();
 				}
 				else {
 					console.log("Cannot enter the api");
 				}
 			
 			});


 		},

 		getMe : function() {
 			return me;
 		},

 		getSchedule: function() {
 			return week;
 		},

 		getAllTasks : function() {
 			return nonDeletedTasks;
 		},

 		getAllRecurrenceTypes : function() {
 			return recurrenceTypes;
 		},

 		getTaskById : function(task_id) {
 			var task = tasks[task_id]
 			if(typeof task === "undefined") {
 				return null;
 			}
 			return task;
 		},

 		addTask: function(task_data) {
 			var task = new Task(task_data);
 			tasks[task.id] = task;
 			nonDeletedTasks[task.id] = task;
 			return task;
 		},

 		remote : function(url, method, request, callback) {

 			var endpoint;
 			if(method == null) {
 				endpoint = url;
 			}
 			else {
 				endpoint = {"url":url, "method":method};
 			}
 			callRemote(endpoint, request, callback);
 		},

 		updateSchedule : function() {
	 		callRemote(links['week'], null, function(response, status){
	 			if(status == "ok") {
	 				var weekData = response;
	 				week = new Week(weekData);
	 				save("week", weekData);
	 				EventProvider.fire(Constants.CHANGE_EVENT);
	 			}
	 		});
 		},

 		updateTasks : function(tasksData) {
 			populateTasks(tasksData);
 		},

 		getLinkTo : function(destination) {
 			return links[destination];
 		}

 	};
 })