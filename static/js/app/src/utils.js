 /**
 * @author Thefuture2092
 *
 */

"user strict";

define(function(){
	var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
 	return {
 		
 		getTodayCode: function() {
 			var today = new Date();
 			var code = today.getDay();
 			return code == 0?7:code;
 		},

 		getDayString: function(day_code) {
 			return DAYS[day_code - 1]; 
 		},

 		convertToHourString: function(hour) {
 			var hour_portion = Math.floor(hour);
 			var minutes = Math.floor((hour %1).toFixed(2) * 60);

 			return hour_portion + "h" + (minutes != 0?minutes:"");

 		}



 	}
 })