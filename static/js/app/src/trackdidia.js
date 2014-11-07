 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["jquery", "models/Schedule"], function($, Schedule){

 	var schedule = null;
 	
 	function init() {

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
 			callRemote({"url":"http://localhost:8080/api/schedules/recurrent"}, null, function(response) {
 				if(response[1] == "ok") {
 					schedule = new Schedule(response[0]);
 					save(response[0]);

 				}
 			});
 		},

 		getSchedule: function() {
 			return schedule;
 		}
 	}
 })