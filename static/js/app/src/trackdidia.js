 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["jquery", "models/Schedule", "models/Task"], function($, Schedule, Task){

 	var links = {}
 	var schedule = null;
 	var tasks = {}

 	function initLinks(){
 		callRemote({"url":"http://localhost:8080/api/enter"}, null, function(response) {
 			if(response[1] == "ok") {
 				links = response[0].links;

 				return true;
 			}

 			return false;
 			
 		});
 	}

 	function initSchedule() {
 		callRemote({"url": links['get_schedule']}, null, function(response){
 			if(response[1] == "ok") {
 				schedule = response[0].response;
 			}
 		});
 	}

 	function initTasks(){
 		callRemote({"url":links['get_tasks']}, null, function(response){
 			if(response[1] == "ok") {
 				tasks_data = response[0].response;
 				links = $.extend({}, links, response[0].links)

 				tasks_data.each(function(task_data) {
 					task = Task(task_data)
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
		if(typeof request != 'string') {
	        request = $.param(request);
		}
		if (typeof endpoint == 'string')
			method = 'GET';
		else {
			endpoint = endpoint.url;
			method = endpoint.method;
		}
	    			 
		request = JSON.stringify(request);
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
				console.log(data);
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
 			var success = initLinks(); // take the return value to force others to wait for this event;
 			initSchedule();
 			initTasks();
 			console.log(links);
 			console.log(tasks);
 			console.log(schedule);
 		},

 		getSchedule: function() {
 			return schedule;
 		},

 		getAllTasks : function() {
 			return tasks;
 		},

 		getTaskById : function(task_id) {
 			var task = tasks[task_id]
 			if(typeof task === "undefined") {
 				return null;
 			}
 			return task;
 		}

 	}
 })