 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/StatMixin", "app/event","app/constants", "app/utils", "app/trackdidia", "bootstrap"], function(React, StatMixin, EventProvider, Constants, Utils, trackdidia){
	var WeekStatComponent = React.createClass({
	    mixins : [StatMixin],

	    getInitialState: function() {
	    	return {'week_stat' : null};
	    },
		componentDidMount: function() {
			EventProvider.subscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},

		componentWillUnmount: function() {
			EventProvider.unsubscribe(Constants.CHANGE_EVENT, "_onChange", this);
		},
		_onChange: function() {
			this.setState(trackdidia.getSchedule());
		},
   render : function() {
        return (
            <div id={this.props.data.id} className="widget">
                {this.renderHeader()}
                {this.renderBody()}
            </div>
        )
    },

    renderHeader : function() {
    	var data = this.props.data;
    	if(this.props.enable_color) {
    		var color = Utils.getPercentColor(data.percent);
    	}
    	else {
    		var color = '';
    	}
        
        var widget_title_class = "widget-title " + color;
        var widget_header_value = "pull-right " + color;
        var total_string = "Points: " + data.result + "/" + data.total;

        return (
            <div title = {total_string} className = "row widget-header">
                <span className="pull-left">
                    <h4> 
                        <img src="/static/images/chevron-blue-down.png" />  
                        <img src="/static/images/draggable_blue.png" /> 
                        <span className={widget_title_class}>{data.title}</span>
                    </h4>
                </span>
                <span title = {total_string} className = {widget_header_value}>
					<h4 > {data.percent}%  {this.getVariation(data.variation)} </h4>
				</span>
            </div>
            );
    },

    renderBody : function() {
        var days = this.props.data.days;
        var body = [];
        if(days != null) {
        	console.log(days);
        	for(var i = 0; i < days.length ; i++) {
            	body.push(this.renderDay(days[i]));
        	}
        }
        

        return (
            <div className = "widget-body">
                <table>
                    {body}                          
                </table>
        
            </div>
            );
    },

    renderDay : function(day) {
    	if(this.props.enable_color) {
    		var color_class = Utils.getPercentColor(day.percent);
    	}
    	else {
    		var color_class = '';
    	}
    	
    	var total_string = "Points: " + day.result + "/" + day.total;

        return (
        	<tr className={color_class} key = {day.id}>
        		<td className='widget-row-label'> {Utils.getDayString(day.id)} </td>
        		<td title={total_string} className='widget-row-value'> {day.percent}% <b>{this.getVariation(day.variation)} </b></td>
        	</tr>
        	);
    }

	});

	return WeekStatComponent;
})