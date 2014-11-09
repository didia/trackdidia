 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["app/trackdidia", "app/Constants", "app/event", "models/Slot"], function(trackdidia, Constants, EventProvider, Slot) {

 	return {
 		scheduleTask : function(day, request) {
 			console.log(day.links);
 			var url = day.links["create_slot"];
 			var method = "POST";

 			console.log(trackdidia);
 			console.log(EventProvider);
 			console.log(Constants);
 			trackdidia.remote(url, method, request, function(response, status) {
 				if(status == "ok") {
 					var slot_data = response.response;
 					var slot = new Slot(slot_data);
 					day.slots[slot.offset] = slot;
 					for(var i = slot.offset; i < slot.offset + slot.duration; i++) {
 						day.usage[i] = true;
 					}

 					EventProvider.fire(Constants.CHANGE_EVENT);

 				}
 			});
 		}
 	}
 })