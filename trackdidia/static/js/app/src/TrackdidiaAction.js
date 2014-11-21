 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["app/trackdidia", "app/constants", "app/event", "models/Slot"], function(trackdidia, Constants, EventProvider, Slot) {

 	return {
 		scheduleTask : function(day, request) {
 			
 			var url = day.links["create_slot"];
 			var method = "POST";

 			console.log(trackdidia);
 			console.log(EventProvider);
 			console.log(Constants);
 			trackdidia.remote(url, method, request, function(response, status) {
 				if(status == "ok") {
 					var task_data;
 					var slot_data;

 					if(response.task) {
 						task_data = response.task;
 						slot_data = response.slot;
 						trackdidia.addTask(task_data);
 					} 
 					else {
 						slot_data = response;
 					}
 					
 					var slot = new Slot(slot_data);
 					day.slots[slot.offset] = slot;
 					for(var i = slot.offset; i < slot.offset + slot.duration; i++) {
 						day.usage[i] = true;
 					}
 					EventProvider.fire(Constants.SLOT_CREATED);
 					EventProvider.fire(Constants.CHANGE_EVENT);

 				}
 				else {
 					EventProvider.fire(Constants.CREATE_SLOT_FAILED, response);
 				}
 			});
 		},

 		setExecuted: function(slot) {
 			var url = slot.links["set_executed"];
 			var method = "POST";
 			trackdidia.remote(url, method, null, function(response, status){
 				if(status == "ok") {
 					var slot_data = response;
 					console.log(slot_data);
 					slot.populate(slot_data);
 					EventProvider.fire(Constants.CHANGE_EVENT);
 				}
 				else {

 				}
 			});
 		},
 		deleteSlot: function(day, slot) {
 			var url = slot.links["delete"];
 			var method = "POST";
 			trackdidia.remote(url, method, null, function(response, status) {
 				if(status == "ok") {
 					console.log("Delete task executed succesfully");
 					var day_data = response;
 					day.populate(day_data);
 					EventProvider.fire(Constants.CHANGE_EVENT);

 				}
 				else {
 					console.log("Delete Slot failed");
 				}
 			})
 		}
 	}
 })