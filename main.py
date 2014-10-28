from xml.sax.saxutils import escape
from django.utils import simplejson
import logging
import webapp2
import os
import jinja2
from google.appengine.api import users
import datetime
from google.appengine.ext import ndb

jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader(os.path.dirname(__file__)))

    
class Task(ndb.Model):
    category = ndb.StringProperty(choices = ['front-end', 'back-end'], required = True)
    description = ndb.TextProperty(required = True)
    name = ndb.StringProperty(required = True)
    created_by = ndb.UserProperty(required = True)
    date_created = ndb.DateTimeProperty(auto_now_add = True)
    last_added = ndb.DateTimeProperty(auto_now = True)
    date_completed = ndb.DateTimeProperty()
    is_completed = ndb.BooleanProperty(default = False)
    is_taken = ndb.BooleanProperty(default = False)

    
    def close(self):
        self.is_completed = True
        self.date_completed = datetime.datetime.now()
    
    def set_taken(self):
        self.is_taken = True
       
    def release(self):
        self.is_taken = False  
        
    def get_task_info(self):
        """
        Function to get information about the ticket
        return a dict that contains info about the ticket
        """
        list_of_info = ['name', 'description', 'category']
        
        task_info = dict()
        
        for attribute in list_of_info:
            task_info[attribute] = getattr(self, attribute)
            
        
        return task_info
     
    @classmethod
    def get_next_task(cls, category):
        free_task_list = cls.query(cls.category==category, cls.is_completed == False, 
                            cls.is_taken == False).order(-cls.last_added)
        return free_task_list.pop() if len(free_task_list)>0 else None
    
   
class MissingArgumentToStartTask(Exception):
    pass
   

 
               
        
             
         

class TaskTrack(ndb.Model):
    """
    This class which will be a child of a user class will help tracking all the task
    the user has completed
    """
    task_tracked = ndb.KeyProperty(required = True, kind = Task)
   
    date_started = ndb.DateTimeProperty(auto_now_add = True)
    date_ended = ndb.DateTimeProperty()
    has_completed = ndb.BooleanProperty(default = False)
    closed = ndb.BooleanProperty(default = False)
    last_updated = ndb.DateTimeProperty(auto_now = True)
    
    def get_task(self):
        return self.task_tracked.get()
    
    def end_track(self):
        self.date_ended = datetime.datetime.now()
        self.has_completed = True
        self.closed = True
    
    def cancel_track(self):
        self.date_ended = datetime.datetime.now()
        self.has_completed = False
        self.closed = True
    def get_track_meaning(self):
        author = self.key.parent().get().user.nickname()
        task = self.task_tracked.get().name
        if not self.date_ended:
            description = author+ " started working on " + task
        else:
            if self.has_completed:
                description = author+ " finished working on " + task
            else:
                description = author+ " stopped working on " + task
        
        return description
    
    def time_delta(self):
        return datetime.datetime.now() - self.date_ended if self.date_ended \
            else datetime.datetime.now() - self.date_started
    
    def elapsed_time_string(self):
        elapsed = self.time_delta()
        
        
        if elapsed.days > 7:
            time_elapsed ="{} weeks ago".format(elapsed.days/7)
        elif elapsed.days:
            time_elapsed = "{} days ago".format(elapsed.days)
        elif elapsed.seconds > 3600:
            time_elapsed = "{} hours ago".format(elapsed.seconds/3600)
        elif elapsed.seconds > 60:
            time_elapsed = "{} minutes ago".format(elapsed.seconds/60)
        else:
            time_elapsed = " few seconds ago"
        
        return time_elapsed
            
            
 
class User(ndb.Model):
    user = ndb.UserProperty(required = True)

    
    def create_task(self, **kwargs):
        if not kwargs.get('description') or not kwargs.get('name'):
            raise MissingArgumentToStartTask("The name or the description was not provided")
        description = kwargs.get('description')
        name = kwargs.get('name') 
        category = kwargs.get('category')      
        
        task = Task(description = description, name = name, category = category, created_by = self.user)
        
        task.put()
    
    def get_current_task(self):
        current_task_tracker = self.get_current_task_tracker()
        
        if current_task_tracker is None:
            return None
        return current_task_tracker.get_task()
        
    def get_current_task_tracker(self):
        
        task_track = TaskTrack.query(ancestor = ndb.Key(self.key.kind(),
                                                    self.key.id()))
        return task_track.filter(TaskTrack.closed == False).get()

    @ndb.transactional(xg = True)   
    def start_task(self, task_id):
        
        self.abandon_current_task()
        
        self.start_a_new_task(task_id)
      
    @ndb.transactional(xg = True)
    def start_a_new_task(self, task_id):
        task = Task.get_by_id(task_id)
        task_key = ndb.Key(task.key.kind(), task.key.id())
        task.set_taken()
        task_track = TaskTrack(parent = ndb.Key(self.key.kind(), self.key.id()), task_tracked = task_key)
        
        ndb.put_multi([task, task_track])

       
    @ndb.transactional(xg = True)
    def abandon_current_task(self):
        current_task_tracker = self.get_current_task_tracker()
        
        if current_task_tracker is None:
            return
        
        task = current_task_tracker.get_task()
        
        current_task_tracker.cancel_track()
        task.release()
        
        ndb.put_multi([task, current_task_tracker])
   
    @ndb.transactional(xg = True)
    def finish_task(self):
        current_task_tracker = self.get_current_task_tracker()
        if current_task_tracker is None:
            return
        task = current_task_tracker.get_task()
        current_task_tracker.end_track()
        task.close()
        
        
        ndb.put_multi([task, current_task_tracker])
        
        
class BaseHandler(webapp2.RequestHandler):

    @webapp2.cached_property
    def user(self):
        """Shortcut to access the current logged in user.

        Unlike user_info, it fetches information from the persistence layer and
        returns an instance of the underlying model.

        :returns
          The instance of the user model associated to the logged in user.
        """
        user_instance = users.get_current_user()
        
        return User.get_or_insert(user_instance.user_id(), user = user_instance)
    
    
    def render_template(self, view_filename, **kwargs):
        context = dict()
        context['user'] = self.user.user.nickname()
        context['url_to_create_task'] = webapp2.uri_for('create_task')
        context.update(kwargs)
        jtemplate = jinja_environment.get_template(view_filename)
        self.response.out.write(jtemplate.render(context))
    def cleanPostedData(self, listOfNamesOfDataToClean):
        """
        Function to clean arguments from html markups 
        
        :param properties:
            A list of arguments name we must clean
        :return edited_values:
            Dict that will contain the cleaned values
        """
        edited_values = {}
        for value in listOfNamesOfDataToClean:
                if self.request.get(value):
                    edited_values[value] = escape(self.request.get(value))
        return edited_values
    def handle_exception(self, exception, debug):
        # Log the error.
        logging.exception(exception)

        # Set a custom message.
        
        self.response.write(exception)

        # If the exception is a HTTPException, use its error code.
        # Otherwise use a generic 500 error code.
        if isinstance(exception, webapp2.HTTPException):
            self.response.set_status(exception.code)
        else:
            self.response.set_status(500)
    
       
class MainHandler(BaseHandler):
    
    def get(self):
        context = self.get_template_context()
        self.render_template('index.html', **context)
        
    def get_template_context(self):
        context = dict()
        context['url_to_abandon'] = webapp2.uri_for('abandon_task')
        context['url_to_finish'] = webapp2.uri_for('finish_task')
        context['current_task'] = self.user.get_current_task()
        context['front_end'] = self.get_stat('front-end')
        context['back_end'] = self.get_stat('back-end')
        context['trackers'] = self.get_tracking_stat()
        context['progression'] = (float(context['back_end']['completed']+context['front_end']['completed'])\
                                /(context['back_end']['total']+context['front_end']['total']))*100
        return context
    
    def get_tracking_stat(self):
        tracker_list = TaskTrack.query().order(-TaskTrack.last_updated).fetch(5)
        
        trackers = zip(map(TaskTrack.get_track_meaning, tracker_list), map(TaskTrack.elapsed_time_string, tracker_list))
        
        return trackers
        
    def get_stat(self, category):
        stat = dict()
        task_list = Task.query(Task.category == category)
        completed_task = task_list.filter(Task.is_completed == True).order(-Task.date_completed)
        completed_task_list = completed_task.fetch()
        stat['completed'] = len(completed_task_list)
        free_task = task_list.filter(Task.is_completed == False, Task.is_taken == False).order(-Task.last_added)
        stat['ongoing_task'] = 1 if task_list.filter(Task.is_completed == False, Task.is_taken == True).get() else 0
        free_task_list = free_task.fetch()
        stat['free_task'] = len(free_task_list)
        if stat['free_task'] > 0:
            stat['next'] = free_task_list.pop()
            next_id = stat['next'].key.id()
            stat['url_to_pick_next'] = webapp2.uri_for('start_task', task_id = next_id)
        
        stat['total'] = stat['completed']+stat['ongoing_task']+stat['free_task']
        return stat
        
        
        


class RpcCreateTaskHandler(BaseHandler):
    
    def post(self):
        posted_data = self.cleanPostedData(['name', 'description', 'category'])
        
        self.user.create_task(**posted_data)
        
        self.send_success_response()
    
    def send_success_response(self):
        self.response.out.write(simplejson.dumps({'message':'success'}))
        
        
class StartTaskHandler(BaseHandler):
    
    
    def get(self, task_id):
    
        self.user.start_task(int(task_id))
        
        self.redirect(webapp2.uri_for('main'))
  
class AbandonTaskHandler(BaseHandler):
    def get(self):
        self.user.abandon_current_task()
        self.redirect(webapp2.uri_for('main'))
   
class FinishTaskHandler(BaseHandler):
    def get(self):
        self.user.finish_task()
        self.redirect(webapp2.uri_for('main'))

class UpdateTaskTrack(BaseHandler):
    def get(self):
        tracker_list = TaskTrack.query().fetch()
        for tracker in tracker_list:
            tracker.put()
        self.redirect(webapp2.uri_for('main'))
          

app = webapp2.WSGIApplication([
    webapp2.Route('/', MainHandler, name='main'),
    webapp2.Route('/rpc/create', RpcCreateTaskHandler, name = 'create_task'),
    webapp2.Route('/abandon', AbandonTaskHandler, name = 'abandon_task'),
    webapp2.Route('/finish', FinishTaskHandler, name = 'finish_task'),
    webapp2.Route('/start/<task_id:[\d]+>', StartTaskHandler, name = "start_task"),
    webapp2.Route('/update', UpdateTaskTrack)
], debug = True)
