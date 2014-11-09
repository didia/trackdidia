 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["jquery", "models/Schedule", "models/Task", "app/event", "app/constants"], function($, Schedule, Task, EventProvider, Constants){

 	var links = {}
 	var schedule = null;
 	var tasks = {};

 	function log(message) {
 		console.log(message);
 	}

 	function initSchedule() {
 		callRemote(links['schedule'], null, function(response, status){
 			if(status == "ok") {
 				var schedule_data = response.response;
 				schedule = new Schedule(schedule_data);
 				save("schedule", schedule_data);
 				EventProvider.fire(Constants.SCHEDULE_LOADED_EVENT);
 			}
 		});
 	}

 	function initTasks(){
 		callRemote(links['tasks'], null, function(response, status){
 			if(status == "ok") {
 				var tasks_data = response.response;
 				log(tasks_data)
 				links = $.extend({}, links, response.links)

 				tasks_data.forEach(function(task_data) {
 					var task = new Task(task_data)
 					tasks[task.id] = task
 				});

 				save("tasks", tasks_data);

 			}
 		});
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
 			callRemote("http://localhost:8080/api/enter", null, function(response, status) {
 				if(status == "ok") {
 					console.log(response);
 					links = response.links;
 					console.log(links)
 					initSchedule();
 					initTasks();
 				}
 				else {
 					console.log("Cannot enter the api");
 				}
 			
 			});


 		},

 		getSchedule: function() {
 			return schedule;
 		},

 		getAllTasks : function() {
 			return tasks;
 		},

 		getTaskById : function(task_id) {
 			console.log(tasks);
 			var task = tasks[task_id]
 			console.log(task);
 			if(typeof task === "undefined") {
 				return null;
 			}
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
 		}

 	};
 })