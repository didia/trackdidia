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
 		},

        toPercent : function(result, total) {
            return Math.round(result * 100 / total);
        },

        getPercentColor : function(percent) {
            var color;
            if(percent < 50) {
                color = "danger";
            }
            else if(percent < 90) {
                color = "warning";
            }
            else {
                color = "success";
            }

            return color;
        },

        addHexColor : function(c1, c2) {
            var hexStr = (parseInt(c1, 16) + parseInt(c2, 16)).toString(16);
            while (hexStr.length < 6) { hexStr = '0' + hexStr; } // Zero pad.
            return hexStr;
        },

 	}
 })